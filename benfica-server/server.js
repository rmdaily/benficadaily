// Servidor de notícias do Benfica
// - Vai buscar noticias novas periodicamente (RSS do Google Noticias)
// - Guarda tudo num ficheiro JSON (historico que nunca se perde)
// - Expõe uma API simples para a página web consumir

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'noticias.json');
const MAX_NOTICIAS = 2000;

// Podes adicionar mais pesquisas aqui (ex: "SL Benfica", "Benfica futebol")
// para apanhar notícias de mais sítios.
const FONTES_RSS = [
  'https://news.google.com/rss/search?q=Benfica&hl=pt-PT&gl=PT&ceid=PT:pt',
];

app.use(cors());
app.use(express.json());

// --- Base de dados simples em ficheiro JSON ---

function garantirFicheiro(){
  const pasta = path.dirname(DATA_FILE);
  if(!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
  if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function lerNoticias(){
  garantirFicheiro();
  try{
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }catch(e){
    console.error('Erro a ler o ficheiro de notícias:', e);
    return [];
  }
}

function guardarNoticias(lista){
  garantirFicheiro();
  fs.writeFileSync(DATA_FILE, JSON.stringify(lista, null, 2));
}

// --- Categorização automática, baseada em palavras-chave no título ---

function categorizar(titulo){
  const t = titulo.toLowerCase();
  if(/mercado|transfer|contrat|refor(ç|c)o|passe|empr(é|e)stimo|assina|rescis/.test(t)) return 'mercado';
  if(/basquetebol|futsal|feminino|andebol|h(ó|o)quei|patinagem/.test(t)) return 'modalidades';
  if(/rui costa|presidente|assembleia|\bsad\b|institui(ç|c)(ã|a)o|s(ó|o)cios/.test(t)) return 'clube';
  return 'equipa';
}

// --- Descobrir o link REAL do artigo, por trás do redirecionamento do Google ---
// O Google Notícias não aponta diretamente para o site da notícia: aponta para
// uma página intermédia dele próprio, que só depois redireciona (com JavaScript)
// para o artigo verdadeiro. Um pedido normal do servidor não executa esse
// JavaScript, por isso vamos procurar o link real escondido no HTML dessa página.

function extrairLinkReal(html){
  const padroes = [
    /data-n-au="([^"]+)"/,           // atributo onde o Google guarda o link real
    /<a[^>]+class="VDXfz"[^>]+href="([^"]+)"/, // variante antiga da página do Google Notícias
  ];
  for(const regex of padroes){
    const match = html.match(regex);
    if(match && match[1]) return match[1].replace(/&amp;/g, '&');
  }
  return null;
}

// --- Buscar uma pequena descrição na própria página da notícia ---
// Vai buscar o HTML da página e tira a "meta description" (o resumo que
// os sites já escrevem para aparecer no Google), sem precisar de nenhuma
// biblioteca extra de scraping.

function extrairDescricao(html){
  const padroes = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
  ];
  for(const regex of padroes){
    const match = html.match(regex);
    if(match && match[1]){
      return match[1]
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ').trim();
    }
  }
  return null;
}

async function buscarHtml(url, timeoutMs = 6000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLBenficaBot/1.0)' },
    });
    if(!res.ok) return null;
    return await res.text();
  }catch(err){
    return null; // site bloqueou, demorou demasiado, etc. — sem problema
  }finally{
    clearTimeout(timer);
  }
}

// Resolve o link real (se for um link do Google Notícias) e vai buscar a
// descrição a essa página final. Devolve { link, descricao }.
async function resolverArtigo(linkOriginal){
  const isLinkGoogle = linkOriginal.includes('news.google.com');
  let linkFinal = linkOriginal;
  let falhouResolucao = false;

  if(isLinkGoogle){
    const htmlIntermedio = await buscarHtml(linkOriginal);
    const linkReal = htmlIntermedio ? extrairLinkReal(htmlIntermedio) : null;
    if(linkReal){
      linkFinal = linkReal;
    }else{
      falhouResolucao = true; // não vale a pena buscar descrição na própria página do Google
    }
  }

  const htmlFinal = falhouResolucao ? null : await buscarHtml(linkFinal);
  let descricao = htmlFinal ? extrairDescricao(htmlFinal) : null;
  if(descricao && descricao.length > 220) descricao = descricao.slice(0, 217) + '…';

  return { link: linkFinal, descricao };
}

// processa uma lista de notícias em pequenos grupos, para não sobrecarregar
async function preencherDescricoes(lista, tamanhoGrupo = 5){
  for(let i = 0; i < lista.length; i += tamanhoGrupo){
    const grupo = lista.slice(i, i + tamanhoGrupo);
    await Promise.all(grupo.map(async (item) => {
      // guarda o link original do Google antes de o substituir, para o
      // reconhecimento de duplicados continuar a funcionar no futuro
      if(!item.linkOrigem) item.linkOrigem = item.link;
      const { link, descricao } = await resolverArtigo(item.linkOrigem);
      item.link = link;
      item.descricao = descricao;
    }));
  }
  return lista;
}

// --- Ir buscar noticias novas e juntar ao historico ---

async function atualizarNoticias(){
  const existentes = lerNoticias();
  // o reconhecimento de duplicados usa sempre o link original do Google
  // (linkOrigem), porque é sempre esse que o RSS devolve — o "link" pode já
  // ter sido substituído pelo link real do artigo
  const linksExistentes = new Set(existentes.map(n => n.linkOrigem || n.link));
  let novas = [];

  for(const rssUrl of FONTES_RSS){
    try{
      const feed = await parser.parseURL(rssUrl);
      for(const item of feed.items){
        if(linksExistentes.has(item.link)) continue;
        const partes = (item.title || '').split(' - ');
        const fonte = partes.length > 1 ? partes.pop() : (feed.title || 'Desconhecida');
        const titulo = partes.join(' - ');
        novas.push({
          titulo,
          link: item.link,
          linkOrigem: item.link,
          fonte,
          categoria: categorizar(titulo),
          publicadoEm: item.pubDate || new Date().toISOString(),
          guardadoEm: new Date().toISOString(),
        });
        linksExistentes.add(item.link);
      }
    }catch(err){
      console.error(`Erro ao ler o feed ${rssUrl}:`, err.message);
    }
  }

  if(novas.length > 0){
    console.log(`A procurar descrições para ${novas.length} notícia(s) nova(s)…`);
    await preencherDescricoes(novas);
  }

  // além das novas, aproveita para corrigir notícias antigas que:
  // - ainda não têm descrição, OU
  // - ficaram com o texto genérico do Google (versão antiga com bug), OU
  // - ainda apontam para o link intermédio do Google em vez do artigo real
  const BOILERPLATE_GOOGLE = 'Comprehensive up-to-date news coverage';
  const precisamCorrecao = existentes.filter(n =>
    !n.descricao ||
    n.descricao.includes(BOILERPLATE_GOOGLE) ||
    n.link.includes('news.google.com')
  ).slice(0, 15);

  if(precisamCorrecao.length > 0){
    console.log(`A corrigir link/descrição em ${precisamCorrecao.length} notícia(s) antiga(s)…`);
    await preencherDescricoes(precisamCorrecao);
  }

  if(novas.length > 0 || precisamCorrecao.length > 0){
    const combinadas = [...novas, ...existentes]
      .sort((a, b) => new Date(b.publicadoEm) - new Date(a.publicadoEm))
      .slice(0, MAX_NOTICIAS);
    guardarNoticias(combinadas);
  }

  console.log(`[${new Date().toLocaleString('pt-PT')}] +${novas.length} notícias novas · total guardado: ${lerNoticias().length}`);
  return novas.length;
}

// --- Rotas da API ---

// GET /api/noticias?categoria=mercado&limit=20
app.get('/api/noticias', (req, res) => {
  const { categoria, limit } = req.query;
  let lista = lerNoticias();
  if(categoria && categoria !== 'todas'){
    lista = lista.filter(n => n.categoria === categoria);
  }
  if(limit){
    lista = lista.slice(0, parseInt(limit, 10));
  }
  res.json({ total: lista.length, noticias: lista });
});

// POST /api/atualizar -> força já uma busca nova (útil para testar)
app.post('/api/atualizar', async (req, res) => {
  const novas = await atualizarNoticias();
  res.json({ ok: true, novasEncontradas: novas, totalGuardado: lerNoticias().length });
});

app.get('/', (req, res) => {
  res.send('Servidor de notícias do Benfica está a correr. Usa /api/noticias para consultar.');
});

// --- Agendamento: corre a cada 30 minutos, sozinho, mesmo sem ninguém a visitar a página ---
cron.schedule('*/30 * * * *', () => {
  atualizarNoticias();
});

app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
  atualizarNoticias(); // corre logo uma vez ao arrancar
});

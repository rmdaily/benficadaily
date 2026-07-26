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

async function buscarDescricao(url, timeoutMs = 6000){
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SLBenficaBot/1.0)' },
    });
    clearTimeout(timer);
    if(!res.ok) return null;
    const html = await res.text();
    const descricao = extrairDescricao(html);
    if(!descricao) return null;
    return descricao.length > 220 ? descricao.slice(0, 217) + '…' : descricao;
  }catch(err){
    return null; // site bloqueou, demorou demasiado, ou não tem meta description — sem problema
  }
}

// processa uma lista de notícias em pequenos grupos, para não sobrecarregar
async function preencherDescricoes(lista, tamanhoGrupo = 5){
  for(let i = 0; i < lista.length; i += tamanhoGrupo){
    const grupo = lista.slice(i, i + tamanhoGrupo);
    await Promise.all(grupo.map(async (item) => {
      item.descricao = await buscarDescricao(item.link);
    }));
  }
  return lista;
}

// --- Ir buscar noticias novas e juntar ao historico ---

async function atualizarNoticias(){
  const existentes = lerNoticias();
  const linksExistentes = new Set(existentes.map(n => n.link));
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

  // além das novas, aproveita para preencher a descrição de notícias antigas
  // que ainda não a têm (feito aos poucos, para não sobrecarregar o servidor)
  const semDescricao = existentes.filter(n => !n.descricao).slice(0, 15);
  if(semDescricao.length > 0){
    console.log(`A preencher descrições em falta em ${semDescricao.length} notícia(s) antiga(s)…`);
    await preencherDescricoes(semDescricao);
  }

  if(novas.length > 0 || semDescricao.length > 0){
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

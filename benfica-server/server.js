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

function categorizar(titulo, descricao){
  const t = `${titulo || ''} ${descricao || ''}`.toLowerCase();
  if(/mercado|transfer|contrat|refor(ç|c)o|passe|empr(é|e)stimo|assina|rescis|renova(ç|c)(ã|a)o|renovar|proposta/.test(t)) return 'mercado';
  if(/benfica b\b|equipa b\b|sub-23|sub-19|sub-17|sub-15|juniores|juvenis|iniciados|academia|campus/.test(t)) return 'modalidades';
  if(/basquetebol|futsal|feminino|andebol|h(ó|o)quei|patinagem/.test(t)) return 'modalidades';
  // nota: "Rui Costa" e "presidente" NÃO entram aqui sozinhos, porque aparecem
  // com frequência em notícias sobre jogadores/mercado (ex: o presidente a
  // comentar uma transferência) — só conta como "Clube" quando é mesmo sobre
  // temas institucionais/de associados
  if(/assembleia|\bsad\b|institui(ç|c)(ã|a)o|s(ó|o)cios|casa(s)? do benfica|caminhada|adepto|associado(s)?|clube de campo|elei(ç|c)(õ|o)es|or(ç|c)amento/.test(t)) return 'clube';
  return 'equipa';
}

// --- Descobrir o link REAL do artigo, por trás do redirecionamento do Google ---
// O Google Notícias não aponta diretamente para o site da notícia: aponta para
// uma página intermédia dele próprio. O link verdadeiro está escondido (cifrado)
// dentro do próprio endereço, e só o "sistema interno" do Google Notícias sabe
// descodificá-lo. Esta função imita esse pedido interno para conseguir o link real.

async function descodificarLinkGoogle(googleUrl, htmlDaPagina){
  try{
    // 1) tira o "código" do artigo a partir do próprio URL
    const { pathname } = new URL(googleUrl);
    const segmentos = pathname.split('/').filter(Boolean);
    const codigoArtigo = segmentos[segmentos.length - 1];
    if(!codigoArtigo) return null;

    // 2) tira a "assinatura" e o "carimbo temporal" escondidos no HTML da página
    const sigMatch = htmlDaPagina.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = htmlDaPagina.match(/data-n-a-ts="([^"]+)"/);
    if(!sigMatch || !tsMatch){
      console.log('[descodificar] não encontrei data-n-a-sg / data-n-a-ts no HTML');
      return null;
    }
    const assinatura = sigMatch[1];
    const carimbo = tsMatch[1];

    // 3) pede ao Google para descodificar, usando o mesmo formato que o
    // próprio site usa internamente (chamada interna "Fbv4je")
    const pedidoInterno = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${codigoArtigo}",${carimbo},"${assinatura}"]`;
    const corpo = 'f.req=' + encodeURIComponent(JSON.stringify([[["Fbv4je", pedidoInterno]]]));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: corpo,
    });
    clearTimeout(timer);
    if(!res.ok){
      console.log(`[descodificar] pedido interno falhou com estado ${res.status}`);
      return null;
    }

    const texto = await res.text();
    const partes = texto.split('\n\n');
    if(partes.length < 2){
      console.log('[descodificar] resposta em formato inesperado');
      return null;
    }
    const dados = JSON.parse(partes[1]);
    const linkReal = JSON.parse(dados[0][2])[1];
    if(typeof linkReal === 'string' && linkReal.startsWith('http')) return linkReal;
    console.log('[descodificar] link decodificado não parece um URL válido:', linkReal);
    return null;
  }catch(err){
    console.log('[descodificar] erro inesperado:', err.message);
    return null; // Google pode ter mudado o formato outra vez, ou bloqueou — sem problema
  }
}

// --- Buscar uma pequena descrição na própria página da notícia ---
// Vai buscar o HTML da página e tira a "meta description" (o resumo que
// os sites já escrevem para aparecer no Google), sem precisar de nenhuma
// biblioteca extra de scraping.

function extrairDescricao(html){
  // primeiro encontra a tag <meta ...> completa (name="description" ou og:description)
  const regexTag = /<meta\s+[^>]*(?:name=["']description["']|property=["']og:description["'])[^>]*>/i;
  const tagMatch = html.match(regexTag);
  if(!tagMatch) return null;

  // só depois tira o valor do "content", usando o MESMO tipo de aspas com que
  // começou — assim, aspas normais dentro do texto (ex: uma citação) já não
  // fazem parar a leitura a meio da frase
  const contentMatch = tagMatch[0].match(/content=(["'])([\s\S]*?)\1/i);
  if(!contentMatch || !contentMatch[2]) return null;

  return contentMatch[2]
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').trim();
}

// Vai buscar o HTML de uma página. Se o site fizer um redirecionamento
// HTTP a sério (não só JavaScript), 'res.url' já vem com o endereço final,
// o que nos poupa um pedido extra.
async function buscarPagina(url, timeoutMs = 7000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9',
      },
    });
    if(!res.ok) return null;
    const html = await res.text();
    return { html, urlFinal: res.url || url };
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

  if(!isLinkGoogle){
    // não é um link do Google: vai só buscar a descrição diretamente
    const pagina = await buscarPagina(linkOriginal);
    let descricao = pagina ? extrairDescricao(pagina.html) : null;
    if(descricao && descricao.length > 220) descricao = descricao.slice(0, 217) + '…';
    return { link: linkOriginal, descricao };
  }

  // é um link do Google — primeiro pedido: pode já resolver tudo de uma vez
  // se o Google fizer um redirecionamento a sério (res.url muda sozinho)
  const primeiraPagina = await buscarPagina(linkOriginal);
  if(!primeiraPagina){
    return { link: linkOriginal, descricao: null };
  }

  if(!primeiraPagina.urlFinal.includes('google.com')){
    // o próprio pedido já nos levou ao site verdadeiro — aproveita logo o HTML
    let descricao = extrairDescricao(primeiraPagina.html);
    if(descricao && descricao.length > 220) descricao = descricao.slice(0, 217) + '…';
    return { link: primeiraPagina.urlFinal, descricao };
  }

  // ainda estamos numa página do Google: descodifica o link verdadeiro
  const linkReal = await descodificarLinkGoogle(linkOriginal, primeiraPagina.html);
  if(!linkReal){
    return { link: linkOriginal, descricao: null }; // não conseguimos descobrir, sem problema
  }

  const segundaPagina = await buscarPagina(linkReal);
  let descricao = segundaPagina ? extrairDescricao(segundaPagina.html) : null;
  if(descricao && descricao.length > 220) descricao = descricao.slice(0, 217) + '…';
  return { link: linkReal, descricao };
}

// processa uma lista de notícias em pequenos grupos, para não sobrecarregar
async function preencherDescricoes(lista, tamanhoGrupo = 6){
  for(let i = 0; i < lista.length; i += tamanhoGrupo){
    const grupo = lista.slice(i, i + tamanhoGrupo);
    await Promise.all(grupo.map(async (item) => {
      // guarda o link original do Google antes de o substituir, para o
      // reconhecimento de duplicados continuar a funcionar no futuro
      if(!item.linkOrigem) item.linkOrigem = item.link;
      const { link, descricao } = await resolverArtigo(item.linkOrigem);
      item.link = link;
      item.descricao = descricao;
      item.categoria = categorizar(item.titulo, item.descricao);
    }));
  }
  return lista;
}

// normaliza um título para comparação (minúsculas, sem acentos, sem pontuação)
// para conseguirmos detetar a MESMA notícia repetida por sites diferentes
function normalizarTitulo(titulo){
  return titulo
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^\w\s]/g, '') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Ir buscar noticias novas e juntar ao historico ---

async function atualizarNoticias(){
  const existentes = lerNoticias();
  // o reconhecimento de duplicados usa sempre o link original do Google
  // (linkOrigem), porque é sempre esse que o RSS devolve — o "link" pode já
  // ter sido substituído pelo link real do artigo
  const linksExistentes = new Set(existentes.map(n => n.linkOrigem || n.link));
  // e também por título, porque o Google Notícias costuma mostrar a MESMA
  // notícia repetida em vários sites (sindicação), com links diferentes
  // mas o título praticamente igual
  const titulosExistentes = new Set(existentes.map(n => normalizarTitulo(n.titulo)));
  let novas = [];

  for(const rssUrl of FONTES_RSS){
    try{
      const feed = await parser.parseURL(rssUrl);
      for(const item of feed.items){
        if(linksExistentes.has(item.link)) continue;
        const partes = (item.title || '').split(' - ');
        const fonte = partes.length > 1 ? partes.pop() : (feed.title || 'Desconhecida');
        const titulo = partes.join(' - ');
        const tituloNormalizado = normalizarTitulo(titulo);
        if(titulosExistentes.has(tituloNormalizado)) continue; // já temos esta notícia de outro site
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
        titulosExistentes.add(tituloNormalizado);
      }
    }catch(err){
      console.error(`Erro ao ler o feed ${rssUrl}:`, err.message);
    }
  }

  // recategoriza TODAS as notícias já guardadas com as regras mais recentes
  // (não custa nada, é só comparar texto, não precisa de aceder à internet)
  let categoriasCorrigidas = 0;
  for(const n of existentes){
    const categoriaCerta = categorizar(n.titulo, n.descricao);
    if(n.categoria !== categoriaCerta){
      n.categoria = categoriaCerta;
      categoriasCorrigidas++;
    }
  }
  if(categoriasCorrigidas > 0){
    console.log(`Categoria corrigida em ${categoriasCorrigidas} notícia(s).`);
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
  ).slice(0, 40);

  if(precisamCorrecao.length > 0){
    console.log(`A corrigir link/descrição em ${precisamCorrecao.length} notícia(s) antiga(s)…`);
    await preencherDescricoes(precisamCorrecao);
  }

  if(novas.length > 0 || precisamCorrecao.length > 0 || categoriasCorrigidas > 0){
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

// controla se já há uma correção total a decorrer, e quanto já foi feito
let correcaoEmCurso = false;
let progressoCorrecao = { feitas: 0, total: 0 };

// POST /api/corrigir-tudo -> corrige TODAS as notícias antigas de uma vez
// (categoria + link real + descrição), sem esperar pelos ciclos automáticos.
// Responde LOGO (para o pedido nunca esgotar o tempo limite do servidor) e
// continua o trabalho em segundo plano. Usa GET /api/progresso para ver como vai.
app.post('/api/corrigir-tudo', async (req, res) => {
  if(correcaoEmCurso){
    return res.json({ ok: true, jaEmCurso: true, ...progressoCorrecao });
  }

  let existentes = lerNoticias();

  // remove duplicados por título (mantém sempre o mais antigo/primeiro visto)
  const titulosVistos = new Set();
  const semDuplicados = [];
  for(const n of existentes){
    const chave = normalizarTitulo(n.titulo);
    if(titulosVistos.has(chave)) continue;
    titulosVistos.add(chave);
    semDuplicados.push(n);
  }
  const duplicadosRemovidos = existentes.length - semDuplicados.length;
  existentes = semDuplicados;

  for(const n of existentes){
    n.categoria = categorizar(n.titulo, n.descricao);
  }
  guardarNoticias(existentes); // já guarda duplicados removidos + categorias corrigidas, já

  const BOILERPLATE_GOOGLE = 'Comprehensive up-to-date news coverage';
  const forcarTudo = req.query.forcar === 'true';
  const precisamCorrecao = forcarTudo
    ? existentes // reprocessa TODAS, mesmo as que já têm descrição (útil depois de melhorar a extração)
    : existentes.filter(n =>
        !n.descricao ||
        n.descricao.includes(BOILERPLATE_GOOGLE) ||
        n.link.includes('news.google.com')
      );

  res.json({
    ok: true,
    duplicadosRemovidos,
    aCorrigirEmSegundoPlano: precisamCorrecao.length,
    total: existentes.length,
    dica: 'Consulta GET /api/progresso para ver como vai.',
  });

  // a partir daqui já respondemos ao pedido — o resto corre sozinho
  correcaoEmCurso = true;
  progressoCorrecao = { feitas: 0, total: precisamCorrecao.length };

  const tamanhoGrupo = 6;
  for(let i = 0; i < precisamCorrecao.length; i += tamanhoGrupo){
    const grupo = precisamCorrecao.slice(i, i + tamanhoGrupo);
    await Promise.all(grupo.map(async (item) => {
      if(!item.linkOrigem) item.linkOrigem = item.link;
      const { link, descricao } = await resolverArtigo(item.linkOrigem);
      item.link = link;
      item.descricao = descricao;
      item.categoria = categorizar(item.titulo, item.descricao);
    }));
    progressoCorrecao.feitas += grupo.length;
    guardarNoticias(existentes); // vai gravando o progresso aos poucos
  }

  correcaoEmCurso = false;
  console.log(`Correção total terminada: ${precisamCorrecao.length} notícias processadas.`);
});

app.get('/api/progresso', (req, res) => {
  res.json({ emCurso: correcaoEmCurso, ...progressoCorrecao });
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

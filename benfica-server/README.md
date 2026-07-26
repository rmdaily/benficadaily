# Servidor de Notícias do Benfica

Este servidor corre sozinho, sem precisares de estar com a página aberta.
De 30 em 30 minutos, vai buscar notícias novas com a palavra "Benfica" e
guarda-as num histórico que nunca se perde (ficheiro `data/noticias.json`).

## Como testar no teu computador

1. Instala o [Node.js](https://nodejs.org) (versão 18 ou superior).
2. Abre um terminal nesta pasta e corre:
   ```
   npm install
   npm start
   ```
3. Abre no browser: `http://localhost:3000/api/noticias`
   Deves ver uma lista de notícias em JSON.
4. Para forçar uma atualização imediata (sem esperar os 30 min):
   ```
   curl -X POST http://localhost:3000/api/atualizar
   ```

## Como pôr isto a funcionar 24 horas por dia, grátis (Render.com)

1. Cria uma conta grátis em https://render.com
2. Coloca este projeto num repositório do GitHub (podes arrastar a pasta
   para https://github.com/new, ou usar o GitHub Desktop se nunca usaste git).
3. No Render, escolhe **New + → Web Service** e liga ao teu repositório.
4. Configurações:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - Plano: **Free**
5. Espera uns minutos até aparecer "Live" — o Render dá-te um endereço
   tipo `https://benfica-noticias.onrender.com`.
6. Testa: `https://benfica-noticias.onrender.com/api/noticias`

⚠️ **Atenção ao plano gratuito do Render:** o servidor "adormece" depois de
15 minutos sem pedidos, e demora uns 30-50 segundos a "acordar" no pedido
seguinte. Para um projeto de escola isto é perfeitamente aceitável — só
avisa quem for ver o site que a primeira vez pode demorar um pouco.

## Ligar a página (o `benfica-diario.html`) a este servidor

Depois de teres o endereço do Render, no ficheiro `benfica-diario.html`
troca esta linha (dentro do `<script>`, na função `loadLiveNews`):

```js
const apiUrl = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(rssUrl);
```

por:

```js
const apiUrl = 'https://benfica-noticias.onrender.com/api/noticias';
```

(troca `benfica-noticias.onrender.com` pelo teu endereço real do Render).

## Adicionar mais fontes de notícias

No ficheiro `server.js`, dentro de `FONTES_RSS`, podes adicionar mais
pesquisas RSS do Google Notícias, por exemplo para apanhar mais variações:

```js
const FONTES_RSS = [
  'https://news.google.com/rss/search?q=Benfica&hl=pt-PT&gl=PT&ceid=PT:pt',
  'https://news.google.com/rss/search?q=%22SL+Benfica%22&hl=pt-PT&gl=PT&ceid=PT:pt',
];
```

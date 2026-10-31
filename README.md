# FF ESTORE

Loja de Passe Booyah: Node.js + Express + PostgreSQL. Sem login de cliente.

## Como colocar no ar (Render)
1. Suba esta pasta para um repositório no GitHub.
2. No Render, crie um **PostgreSQL** e copie a *Internal Database URL*.
3. Crie um **Web Service** (Node): Build `npm install`, Start `npm start`.
4. Em *Environment*, defina:
   - `DATABASE_URL`, `AUTOSYSTEM_API_KEY`, `MERCADOPAGO_ACCESS_TOKEN` (produção), `ADMIN_PASSWORD`
   - `PUBLIC_URL` (ex.: https://ffestore.onrender.com), `NODE_ENV=production`
5. Mercado Pago → Suas integrações → Webhooks: URL `https://SEU-SITE/api/webhooks/mercadopago`, evento **Pagamentos**. Não é preciso copiar nenhuma chave secreta.
6. Abra `/admin`, entre com a senha, defina preço, imagem e **estoque**, e mude o status para DISPONÍVEL.

## Antes de vender (confirmar com dados reais)
- **Formato das respostas da API autolikesystem.** Não recebi exemplos. O código procura nome/nível em chaves comuns (`nickname`, `name`, `level`…) e considera falha quando há `error`/`success:false`/HTTP != 200. Faça 1 consulta e 1 entrega reais e ajuste `lookupPlayer` e `looksFailed` em `server.js` se necessário. Toda resposta de entrega fica gravada em `delivery_attempts` (visível no painel).
- **E-mail do pagador:** o Mercado Pago exige um e-mail; o cliente não digita nenhum. Usa-se `cliente@ffestore.com.br` (troque com `PAYER_EMAIL`).

## Garantias implementadas
- Chaves só no servidor; senha admin só em variável de ambiente (cookie assinado, HttpOnly, 8 h, limite de tentativas).
- Valor vem do banco; o servidor refaz a consulta do UID; pagamento é sempre reconfirmado na API do Mercado Pago (webhook com assinatura HMAC + checagem de valor e `external_reference`).
- Entrega: só com pagamento `approved`; reivindicação atômica no banco (uma entrega por pedido); erro de entrega não cobra de novo. Reenvio só pelo admin e só para pedido pago. Se a API não responder, o resultado é "incerto" e nada é reenviado sozinho.
- Estoque: reserva atômica por PIX (30 min), liberada ao expirar/cancelar/rejeitar, baixa definitiva após entrega confirmada, status vira SEM ESTOQUE sozinho.

## Reembolso automático
Se a API de entrega **recusar** o pedido (resposta HTTP abaixo de 500 indicando falha), o sistema devolve o valor integral pelo Mercado Pago, libera a reserva do estoque e mostra ao cliente "Pedido reembolsado". Se a API não responder ou der erro 5xx, o resultado é incerto: nada é reembolsado sozinho e o painel oferece REENVIAR ou REEMBOLSAR depois que você conferir no jogo.
**Importante:** como a detecção de falha depende do formato da resposta da API (ver acima), teste uma entrega real e uma falha real (ex.: UID inválido) antes de abrir a loja. Uma detecção errada poderia reembolsar um pedido que foi entregue.

## Painel admin
Toque 5 vezes seguidas no ícone "FF" do topo do site para abrir `/admin` (que pede a senha). O endereço `/admin` continua funcionando direto, sempre protegido por senha.

## Webhook
Só o `MERCADOPAGO_ACCESS_TOKEN` é necessário. O aviso do webhook funciona apenas como gatilho: o servidor sempre consulta o pagamento direto no Mercado Pago (status, valor e número do pedido) antes de aprovar ou entregar, e a tela do cliente também confere sozinha a cada poucos segundos.

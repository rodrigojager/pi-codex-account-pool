// Official Pi logo geometry and colors: https://pi.dev/logo-auto.svg
// Embedded locally: the OAuth callback never loads third-party assets.
export function oauthSuccessPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="referrer" content="no-referrer">
  <title>Conta autorizada · Pi</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #f3f3f5; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 40px 20px; background: radial-gradient(ellipse at 50% 12%, #f090820b, transparent 55%), radial-gradient(ellipse at 85% 90%, #4d9abf09, transparent 50%), #0b0d10; }
    main { width: min(100%, 520px); text-align: center; animation: arrive .55s ease-out both; }
    .brand { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 32px; }
    .logo { width: 52px; height: 52px; }
    .brand-name { font-size: 30px; font-weight: 650; letter-spacing: -1.5px; }
    .card { position: relative; overflow: hidden; padding: 44px 36px 32px; border: 1px solid #2b2d34; border-radius: 24px; background: linear-gradient(155deg, #191b20, #111317 75%); box-shadow: 0 24px 80px #0005; }
    .card::before { content: ""; position: absolute; inset: 0 18% auto; height: 1px; background: linear-gradient(90deg, transparent, #f0908280, transparent); }
    .check { display: grid; place-items: center; width: 64px; height: 64px; margin: 0 auto 24px; color: #9bd8b1; background: #9bd8b110; border: 1px solid #9bd8b12c; border-radius: 50%; box-shadow: 0 0 36px #9bd8b107; }
    .check svg { width: 28px; height: 28px; }
    .eyebrow { margin: 0 0 12px; color: #f09082; font-size: 11px; font-weight: 650; letter-spacing: 2.2px; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(26px, 5vw, 34px); line-height: 1.2; letter-spacing: -1.1px; font-weight: 650; }
    .description { margin: 16px auto 28px; max-width: 350px; color: #afb1bd; font-size: 15px; line-height: 1.7; }
    .next { padding: 20px; border: 1px solid #30323a; border-radius: 14px; background: #ffffff03; }
    .next-title { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 8px; font-size: 14px; font-weight: 600; }
    .terminal { color: #f1be58; font-family: ui-monospace, Consolas, monospace; font-size: 17px; }
    .next p:last-child { margin: 0; color: #a7a9b5; font-size: 13px; line-height: 1.7; }
    .close-hint { margin: 24px 0 0; color: #9699a5; font-size: 12px; }
    footer { margin-top: 26px; color: #858995; font-size: 11px; letter-spacing: .5px; }
    footer span { padding: 0 8px; color: #535762; }
    @keyframes arrive { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { main { animation: none; } }
    @media (max-width: 420px) { body { padding: 24px 16px; } .card { padding: 32px 22px 26px; } .brand { margin-bottom: 22px; } }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <div class="brand">
      <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" role="img" aria-label="Logo do Pi">
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/>
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/>
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/>
      </svg>
      <span class="brand-name">pi</span>
    </div>
    <section class="card" aria-labelledby="title">
      <div class="check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></div>
      <p class="eyebrow">Codex Account Pool</p>
      <h1 id="title">Tudo certo por aqui.</h1>
      <p class="description">Sua conta ChatGPT foi autorizada com sucesso para uso no Pi.</p>
      <div class="next">
        <p class="next-title"><span class="terminal" aria-hidden="true">&gt;_</span> Continue no terminal</p>
        <p>Volte ao Pi para finalizar a adição da conta<br>e continuar de onde parou.</p>
      </div>
      <p class="close-hint">Você já pode fechar esta aba.</p>
    </section>
    <footer>Pi <span aria-hidden="true">/</span> Extensão Codex Account Pool</footer>
  </main>
</body>
</html>`
}

export const oauthPageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  Connection: "close",
}

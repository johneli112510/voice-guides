# Voice Guides (single Cloudflare Worker + R2)

Upload sheet music (PDF, PNG, JPG, JPEG, WebP) and up to 10 MP3 practice tracks per piece,
each tagged Soprano, Alto, Tenor, Bass or Other. Everyone can view and listen; only someone
who knows the admin password can add, edit or delete.

Files (all at the repo root, no folders needed):
- `worker.js`      the whole app: web page + API
- `wrangler.toml`  R2 binding named BUCKET

## Deploy from Git (Cloudflare Workers Builds)
1. Create the R2 bucket first: dashboard > R2 > Create bucket > `voice-guides`.
2. Put `worker.js` and `wrangler.toml` at the root of your repo and push.
   Build command: empty. Deploy command: `npx wrangler deploy`.
3. Worker > Settings > Variables and Secrets > Add > type Secret, name `ADMIN_PASSWORD`.
   Then retry the deployment.

## Deploy from your computer
    npm i -g wrangler
    wrangler login
    wrangler r2 bucket create voice-guides
    wrangler deploy
    wrangler secret put ADMIN_PASSWORD

## Notes
- One file can be up to 90 MB (Cloudflare caps a request at 100 MB on the free plan).
- Use a long password; there is no lockout on repeated attempts.
- Change SITE_TITLE / SITE_SUB by searching for them inside worker.js.

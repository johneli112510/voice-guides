# Voice Guides (Cloudflare Worker + static assets + R2)

Upload sheet music (PDF, PNG, JPG, JPEG, WebP) and up to 10 MP3 practice tracks per piece,
each tagged Soprano, Alto, Tenor, Bass or Other. Everyone can view and listen; only someone
who knows the admin password can add, edit or delete.

- `public/index.html`  the front end (edit the title at the top of its script)
- `worker.js`          the Worker: /api/* is the API, everything else is served from public/
- `wrangler.toml`      static assets + R2 binding named BUCKET

## Deploy from Git (Cloudflare Workers Builds)
1. Create the bucket first: Cloudflare dashboard > R2 > Create bucket > name it `voice-guides`
   (the deploy fails if the bucket in wrangler.toml does not exist).
2. Put this folder's contents at the root of your repo so the repo root shows wrangler.toml,
   worker.js and the public folder (with index.html inside). Push. Build command: leave empty. Deploy command: `npx wrangler deploy`.
3. Add the password: Worker > Settings > Variables and Secrets > Add > type Secret,
   name `ADMIN_PASSWORD`. Then redeploy (Deployments > retry, or push a commit).

## Deploy from your computer
    npm i -g wrangler
    wrangler login
    wrangler r2 bucket create voice-guides
    wrangler deploy
    wrangler secret put ADMIN_PASSWORD

## Test locally
    cp .dev.vars.example .dev.vars   # edit the password
    wrangler dev

## Notes
- One file can be up to 90 MB (Cloudflare caps a request at 100 MB on the free plan).
- Use a long password; there is no lockout on repeated attempts.
- Piece details are stored in `index.json` in the bucket, files under `pieces/`.

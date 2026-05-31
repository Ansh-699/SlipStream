# Deploying Slipstream

Slipstream is three independent pieces with different hosting needs. Deploy them
to the hosts each is actually good at — don't force everything onto one platform.

| Piece | What it is | Recommended host | Why |
|---|---|---|---|
| **Frontend** (`frontend/`) | Next.js 16 app with SSR + Node API routes | **Vercel** | Built by the makers of Next.js; the `/api/rpc/*` and `/api/pyth/*` Node routes work zero-config; global CDN, auto HTTPS, git-push deploys. |
| **Keepers** (`keepers/`) | Long-running Node bots (settlement, funding, liquidation, TWAP) | **DigitalOcean droplet** (or AWS Lightsail/EC2) | They run forever in a loop — serverless platforms (incl. Vercel) **cannot** host them. They need a persistent VM. |
| **On-chain program** (`programs/`) | Already deployed to Solana devnet | — | Lives on-chain; nothing to host. |

**TL;DR: Vercel for the frontend + one small DO droplet for the keepers.**

Why not all-AWS: AWS would work (Amplify + EC2/ECS) but it's the most setup for
zero benefit here. Why not all-Vercel: the keepers are long-lived processes;
Vercel functions time out. The split below is the least work for the best result.

---

## Part 1 — Frontend on Vercel

The production build is verified working (`npm run build` → static `/` + two
dynamic API routes). Addresses come from the committed `deploy.json`, so no env
vars are strictly required.

### Option A — Vercel dashboard (easiest)

1. Push to GitHub (already done: `github.com/Ansh-699/SlipStream`).
2. On vercel.com → **Add New Project** → import the repo.
3. Set **Root Directory** to `frontend`. Vercel auto-detects Next.js.
4. Deploy. That's it — `vercel.json` and the committed `deploy.json` handle the rest.

### Option B — Vercel CLI

```bash
npm i -g vercel
cd frontend
vercel            # first run links/creates the project
vercel --prod     # production deploy
```

### Frontend environment variables (all optional)

Set these in Vercel only if you want to point at a different deployment than the
committed `deploy.json`:

| Variable | Purpose |
|---|---|
| `BASE_RPC_UPSTREAM` | Override the L1 RPC the `/api/rpc/base` proxy forwards to (e.g. a paid Helius/QuickNode devnet endpoint — recommended for reliability). |
| `ER_RPC_UPSTREAM` | Override the MagicBlock ER RPC. |
| `PYTH_BENCHMARKS_UPSTREAM` | Override the Pyth Benchmarks history upstream. |
| `NEXT_PUBLIC_PROGRAM_ID` / `NEXT_PUBLIC_MARKET` / `NEXT_PUBLIC_ORDER_BOOK` | Override on-chain addresses. |
| `NEXT_PUBLIC_RPC_URL` / `NEXT_PUBLIC_ER_RPC` | Override the direct RPC URLs used for Explorer links and SSR. |

> **Tip:** the free public devnet RPC (`api.devnet.solana.com`) is rate-limited.
> For a smooth demo, set `BASE_RPC_UPSTREAM` to a dedicated devnet RPC.

---

## Part 2 — Keepers on a VM (DigitalOcean)

The keepers must run continuously. Easiest path is Docker Compose on a small
droplet.

### 2.1 Create the droplet

- DigitalOcean → Create Droplet → Ubuntu 24.04, Basic, **2 GB RAM / 1 vCPU** is
  plenty. Add your SSH key.
- (AWS equivalent: a Lightsail instance or a `t3.small` EC2 — same steps below.)

### 2.2 Install Docker

```bash
ssh root@<droplet-ip>
curl -fsSL https://get.docker.com | sh
```

### 2.3 Get the code + secrets onto the VM

```bash
git clone https://github.com/Ansh-699/SlipStream.git
cd SlipStream

# Keeper config
cp keepers/.env.example keepers/.env
nano keepers/.env          # set BASE_RPC / ER_RPC (a dedicated devnet RPC is best)

# Signing keypair — the operator key (mint authority).
# Copy your local ~/.config/solana/id.json to the VM, then:
mkdir -p secrets
mv id.json secrets/keeper-id.json
chmod 600 secrets/keeper-id.json
```

> `secrets/` and `keepers/.env` are git-ignored — they will never be committed.
> The keeper key signs settlement/funding/liquidation transactions and is the
> USDC mint authority, so treat it like a production secret.

### 2.4 Run

```bash
docker compose up -d --build     # builds the image, starts all keepers
docker compose logs -f           # watch them crank
docker compose ps                # status
```

Each keeper is its own service (`fill-log`, `funding`, `liquidation`, `twap`,
`market-maker`) with `restart: unless-stopped`, so one crashing bot restarts on
its own and survives reboots. To run without demo bot order flow, comment out the
`market-maker` service in `docker-compose.yml`.

### 2.5 Update after a code change

```bash
git pull && docker compose up -d --build
```

---

## Part 3 — Re-deploying / upgrading the on-chain program

Already deployed to devnet (see `deploy.json`). Only needed if you change the
Rust program:

```bash
# from slipstream/
cargo build-sbf --manifest-path programs/slipstream/Cargo.toml
tsx scripts/deploy.ts        # redeploys + rewrites deploy.json
```

After a redeploy, commit the updated `deploy.json` and redeploy the frontend so
it picks up any new addresses:

```bash
git add deploy.json && git commit -m "chore: update deploy manifest" && git push
# Vercel auto-rebuilds on push; on the VM: git pull && docker compose up -d --build
```

---

## What gets exposed (security note)

- The **frontend** is public — fine, it only holds public addresses.
- The **`/api/rpc/*` proxy** forwards arbitrary JSON-RPC to devnet endpoints. It's
  unauthenticated by design (it's a read/relay proxy to public RPCs). If you move
  to mainnet, put it behind rate limiting and lock the upstreams down.
- The **keeper key** lives only on the VM (git-ignored, `chmod 600`). It is never
  in the repo or the frontend bundle.
- This is a **devnet MVP** — see [`README.md`](./README.md) Trust Model for the
  full list of devnet concessions before considering mainnet.

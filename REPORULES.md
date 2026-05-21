# REPORULES — Multi-Machine Repository Discipline

Two machines. Same repos. No drift. No lost work.

## Machine Roles

| Machine | Role | Path |
|---------|------|------|
| **This machine** (kirk-688526g) | Development + local benchmark | `/home/kirk/Madlab/Clean-Live/` |
| **.225 machine** | Codex-driven development | `~/Madlab/` (or equivalent) |

## The Golden Rule

**GitHub is the source of truth. Always.** Never have work on one machine that isn't pushed. Before switching machines:

```sh
# On the machine you're leaving:
cd /home/kirk/Madlab/Clean-Live/<repo>
git add -A && git commit -m "wip: save point" && git push

# On the machine you're arriving at:
cd /home/kirk/Madlab/Clean-Live/<repo>
git pull
```

## Repo Layout

Every KirkForge repo lives in `/home/kirk/Madlab/Clean-Live/`:

```
/home/kirk/Madlab/Clean-Live/
├── REPORULES.md              ← this file
├── 55NDeep-v8/               → github.com/KirkForge/55NDeep-plugin
├── PicoSentry/               → github.com/KirkForge/PicoSentry
├── ForagerFlow/              → github.com/KirkForge/ForagerFlow
├── Dopaflow/                 → github.com/KirkForge/Dopaflow
├── Sword-jin_PWA/            → github.com/KirkForge/Sword-jin_PWA
├── MCP/                      → github.com/KirkForge/MCP
├── browser-integration-llm/  → github.com/KirkForge/Browser_integration_llm
├── pet-wifi-sense/           → github.com/KirkForge/PetSense
└── KirkForge/                → github.com/KirkForge/KirkForge (profile)
```

## No Sandbox Divergence

The sandbox (`/home/kirk/Madlab/sandbox/`) is for **runtime only** — benchmarks, Docker, npm install artifacts. Never edit source code there. If you need to test changes:

1. Edit in Clean-Live
2. Sync to sandbox: `rsync -av --exclude node_modules --exclude .git Clean-Live/<repo>/ sandbox/<repo>/`
3. Test in sandbox
4. Commit from Clean-Live

Or use the sync script: `scripts/sync-to-sandbox.sh`

## Git Identity

Set this on every machine before committing:

```sh
git config --global user.name "YOUR REAL NAME"
git config --global user.email "your@real.email"
```

**Never use "KirkForge" as the author name.** That's an org, not a person.

Commit format:
```
type(scope): what changed

Optional body with details.
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `wip`

## Before Every Session

```sh
cd /home/kirk/Madlab/Clean-Live
for repo in */; do
  cd "$repo" && git pull && cd ..
done
```

## After Every Session

```sh
cd /home/kirk/Madlab/Clean-Live/<repo>
git add -A && git status --short
git commit -m "..."  # meaningful message
git push
```

## Auth

GitHub PAT is in `/home/kirk/Madlab/Toolbox_meatbag/.github_pat_classic`. Use it for HTTPS auth:

```sh
git clone https://$(cat /home/kirk/Madlab/Toolbox_meatbag/.github_pat_classic)@github.com/KirkForge/<repo>.git
```

Never hardcode the PAT in scripts. Always read from the file.

## Codex Agent Instructions

When working with a Codex agent, point it at Clean-Live:

```
Work in /home/kirk/Madlab/Clean-Live/<repo>.
Always commit and push before ending the session.
Read REPORULES.md at the start of every session.
```

## New Repo Bootstrap

```sh
# On GitHub: create repo (do NOT add README/.gitignore — use existing)
cd /home/kirk/Madlab/Clean-Live/<project>
git init
git add -A
git commit -m "Initial commit"
git remote add origin https://$(cat /home/kirk/Madlab/Toolbox_meatbag/.github_pat_classic)@github.com/KirkForge/<repo>.git
git push -u origin master
```

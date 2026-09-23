# Oficina web en tailnet (headless, 0.0.0.0:8888)

Spec v1.2. Sin `tailscale serve`, `funnel` ni tunnelmole: el server escucha en
todas las interfaces y el **firewall** restringe a `tailscale0`.

> UI completa: `GET /` sirve la app Electron en el browser (floor, terminales,
> Command Center) vía shim `window.cth` → WS. `GET /agentes` es la vista
> ligera alternativa (Mis agentes). Ambas piden el `WEB_TOKEN` una vez por
> pestaña y lo guardan en `sessionStorage`.

## 1. Arranque

```bash
export WEB_TOKEN="$(openssl rand -hex 32)"   # o en .env: WEB_TOKEN=...
export OLLAMA_HOST="http://100.x.y.z:11434"  # Ollama en otro nodo tailnet
docker compose -f docker-compose.web.yml up -d --build
# UI completa:  http://100.78.144.4:8888/
# Vista ligera: http://100.78.144.4:8888/agentes
```

Vars: `WEB_HOST` (default `0.0.0.0`), `WEB_PORT` (default `8888`), `WEB_TOKEN`
(requerida), `HARNESS_HOME=/data` (volumen `harness-data`, persistente con
`restart: unless-stopped`).

## 2. WEB_TOKEN

Toda llamada API/Slack exige `Authorization: Bearer $WEB_TOKEN` (ERR-W01 si
falta/inválido, ver `src/shared/webBridge.ts`). Rota con:

```bash
docker compose -f docker-compose.web.yml up -d --force-recreate  # tras cambiar WEB_TOKEN
```

## 3. Firewall solo-tailscale0

El puerto 8888 **nunca** se expone a LAN/WAN, solo a la tailnet:

```bash
# ufw
sudo ufw allow in on tailscale0 to any port 8888
sudo ufw status numbered | grep 8888   # verificar: sin regla en otras interfaces

# iptables equivalente
sudo iptables -A INPUT -i tailscale0 -p tcp --dport 8888 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8888 -j DROP   # protege eth0/wlan0
```

## 4. Slack

Webhook del nodo office (Slack → harness):

```text
http://100.78.144.4:8888/hooks/slack
```

Firma HMAC/replay con el signing secret existente (`src/main/slack.ts`,
ERR-W04 si falla). El token Bearer **no** sustituye la firma Slack: se usan ambos.

## 5. Ollama remoto (tailnet)

Ollama vive en **otra** IP tailnet, no en este contenedor:

```bash
export OLLAMA_HOST="http://100.x.y.z:11434"
curl "$OLLAMA_HOST/api/tags"   # verificar alcance desde el nodo office
```

## 6. Troubleshooting

**ABI node-pty (ERR-W07: pty no disponible).** El `postinstall`
(`electron-rebuild -f`) compila `node-pty` contra el ABI de Electron, que no
carga bajo Node plano. El `Dockerfile.web` runtime ya lo evita:
`npm ci --omit=dev --ignore-scripts` + `npm rebuild better-sqlite3 node-pty`
contra Node 22. Si ves `was compiled against a different Node.js version`:

```bash
docker compose -f docker-compose.web.yml exec web \
  npm rebuild node-pty better-sqlite3 --build-from-source
```

**Puerto ocupado.** Otro proceso usa 8888 (`EADDRINUSE` en logs):

```bash
ss -ltnp | grep 8888
WEB_PORT=8890 docker compose -f docker-compose.web.yml up -d  # o libera el 8888
```

**Healthcheck rojo.** `docker inspect <id> | grep -A5 Health`; el check pide
`GET /agentes` en `127.0.0.1:$WEB_PORT`. Si el slice backend aún no expone
`/agentes`, es esperado hasta que `start:web` exista (ver TODO arriba).

# Internetga joylash (VPS + Docker + avtomatik HTTPS)

Kerak: Ubuntu VPS (1 GB RAM yetadi), domen (DNS A yozuvi VPS IP'ga), 80 va 443 portlari ochiq.

```bash
# 1) Docker
curl -fsSL https://get.docker.com | sh
# 2) Loyiha
apt install -y unzip && unzip synaptox-v2.zip && cd synaptox
# 3) Sozlamalar
cp .env.example .env && nano .env      # TOKEN, ADMIN_TELEGRAM_ID, LLM_*, SEARCH_KEY, PAY_CARD ...
#    SESSION_SECRET va ENC_KEY:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  (yoki: openssl rand -hex 32)
# 4) Ishga tushirish (domenni yozing)
DOMAIN=synaptox.uz docker compose up -d --build
docker compose logs -f app             # "bot:ha" va "ishga tushdi: @..." chiqishi kerak
```
`https://synaptox.uz` ochiladi (sertifikatni Caddy o'zi oladi va yangilaydi).

## Xavfsizlik (bir marta)
```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```
`app` konteyneri tashqariga ochilmagan (faqat Caddy orqali) — `TRUST_PROXY=1` shuning uchun xavfsiz.

## Yangilash
Yangi zipni oching, `.env` ni ko'chiring, so'ng `DOMAIN=... docker compose up -d --build`. Ma'lumotlar `data` volume'da qoladi.

Amaldagi VPS konteyneriga ffmpeg qo‘shish yoki yangilash uchun loyiha papkasida:
```bash
docker compose up -d --build app
docker compose exec app ffmpeg -version
docker compose exec app ffprobe -version
```
`Dockerfile` ffmpeg va ffprobe'ni image ichiga o‘rnatadi; host operatsion tizimiga alohida o‘rnatish shart emas. Agar `docker compose exec` konteyner hali ishga tushmagan desa, `docker compose logs app` chiqishini tekshiring.

## Zaxira
- Baza har kuni avtomatik nusxalanadi (`/data/backups`, oxirgi 7 ta).
- Qo'lda to'liq zaxira (baza + fayllar):
  `docker run --rm -v synaptox_data:/data -v $PWD:/b alpine tar czf /b/synaptox-backup.tgz /data`
- `.env` ni (ayniqsa `ENC_KEY`) alohida xavfsiz joyda saqlang. Usiz shifrlangan ma'lumotlarni ochib bo'lmaydi.

## Nosozliklarni topish
| Alomat | Sabab / yechim |
|---|---|
| Sayt ochilmaydi | DNS hali yetib bormagan yoki 80/443 yopiq: `docker compose logs caddy` |
| Kirib bo'lmaydi (cookie) | Sayt `https://` orqali ochilishi kerak (production'da cookie `Secure`) |
| `bot:yo'q` / polling xato | Token noto'g'ri yoki server `api.telegram.org` ga chiqa olmayapti |
| `llm:yo'q` | `LLM_URL`+`LLM_KEY`+`LLM_MODEL` yoki `OLLAMA_URL` bo'sh |
| AI javobi "bilmayman" | LLM kaliti/model nomi xato: `docker compose logs app` |
| Montaj ishlamaydi | `docker compose up -d --build app` bilan image'ni qayta yarating; `docker compose exec app ffmpeg -version` va `ffprobe -version` bilan tekshiring. `.env`dagi `FONT_FILE` ni o'zgartirmang |
| Konteyner qayta-qayta o'chadi | `.env` da `SESSION_SECRET`/`ENC_KEY` yo'q yoki 24 belgidan qisqa |

Salomatlik tekshiruvi: `curl https://synaptox.uz/api/health`

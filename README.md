# SYNAPTOX v2 — Web + PWA ilova + Telegram bot

Bitta server: sayt, telefon ilovasi (PWA), Telegram bot va umumiy ma'lumotlar bazasi (SQLite, `node:sqlite`). Tashqi npm paketlar **yo'q**.

## Ishga tushirish
```
node -v
if (-not (Test-Path .env)) { Copy-Item .env.example .env }   # PowerShell; mavjud .env'ni saqlab qoladi
npm start               # server oynasini ochiq qoldiring
npm test                 # avtomatik testlar
```
Windows'da serverni alohida ochiq konsolda boshlash uchun `start-windows.bat` faylini ishga tushiring. Skript Node.js 22.5+, npm va asosiy loyiha fayllarini tekshiradi; server xatolik bilan to‘xtasa, exit code va port bandligi bo‘yicha ko‘rsatma beradi. Video montaj uchun FFmpeg va FFprobe kerak; Windows'da ular PATH'dan yoki `%LOCALAPPDATA%\Programs\Synaptox\ffmpeg` papkasidan avtomatik topiladi. Boshqa papkada bo‘lsa, `.env` ichida `FFMPEG_BIN_DIR` bilan bin papkasini ko‘rsating. Skript oynasini server ishlashi uchun ochiq qoldiring.
Bundan tashqari, kompyuter uchun alohida Windows dasturi va telefon uchun PWA mavjud. Windows dasturini tayyorlash: `npm run desktop:dist`; batafsil ko‘rsatma: `desktop/README.md`. Telefonni o‘rnatish Android/iPhone brauzeridan amalga oshiriladi; kompyuter brauzerida telefon ilovasini o‘rnatish tugmasi ko‘rsatilmaydi.
Birinchi marta: saytda ro'yxatdan o'ting → profilda **Telegram → Kod olish** → botga `/link KOD` yuboring. `ADMIN_TELEGRAM_ID` sizniki bo'lgani uchun akkauntingiz avtomatik **admin** bo'ladi (🛡 Admin bo'limi ochiladi).

## Nimalar bor
| Bo'lim | Holati |
|---|---|
| Chat + o'z bilim bazasi (BM25 qidiruv, `/teach`, `/remember`, 👍/👎 orqali o'rganish) | ✅ ishlaydi, tashqi modelsiz |
| LLM (Ollama) ulash | ixtiyoriy: `OLLAMA_URL` |
| Fayl yuklash (rasm, PDF, DOCX, TXT, audio, video) — haqiqiy tur baytlardan aniqlanadi | ✅ |
| PDF/DOCX/TXT matnini tahlil qilish | ✅ (`pdftotext`, `unzip` kerak; Docker'da bor) |
| Rasm tavsifi | `OLLAMA_VISION_MODEL` (masalan `llava`) sozlansa |
| Ovozli suhbat (web) | ✅ 50+ til; suhbat paneli, jonli transkripsiya va tinglashni pauza qilish. Nutq va javob ovozi profildagi nutq tiliga moslanadi; STT serveri sozlansa zaxira transkripsiya yoqiladi |
| Ilova interfeysi | 53 til tanlanadi va qurilma tili aniqlanadi. Barcha 53 til uchun asosiy navigatsiya va amallar offline tarjima qilingan; 14 tilning kengroq kataloglaridagi qolgan iboralar hamda qolgan 39 tilning to‘liq matnlari bosqichma-bosqich qo‘shiladi. |
| Telegram ovozli xabar → matn | `STT_URL` (OpenAI-mos, masalan faster-whisper-server) sozlansa |
| Video montaj (AI ko‘rsatma asosida reja, timeline, kliplarni tanlash/tartiblash/kesish, rasm klip, filtr, tezlik, yozuv, musiqa, audio ajratish) | ✅ ffmpeg orqali; AI uchun `LLM_URL` yoki `OLLAMA_URL` sozlang |
| Loyihalar: vazifalar, shifrlangan qaydlar, fayl biriktirish, loyiha ichida suhbat | ✅ |
| Profil: avatar, ma'lumotlar, parol, barcha qurilmalardan chiqish, ma'lumotni eksport, akkauntni o'chirish | ✅ |
| Tarif va to'lov: karta o'tkazmasi → chek → admin tasdiqlaydi (web yoki Telegram tugmasi) | ✅ (`PAY_CARD` kiriting) |
| Admin panel: 14 kunlik va 7/30 kunlik faollik, eng faol foydalanuvchilar, xavfsizlik ogohlantirishlari, holat/tarif filtrlari va CSV eksport, foydalanuvchi hisoboti, sana/holat/qidiruvli to'lovlar va CSV, 15 daqiqalik amalni qaytarish, Toshkent vaqti bo'yicha rejalashtirilgan Telegram e'lonlari, bilimlar va audit | ✅ |
| Telegram bot | ✅ Chat, fayl/ovoz/rasm, 👍/👎, suhbat va loyiha/vazifa boshqaruvi, profil tili, to‘lov va video montaj; admin: `/admin /pending /broadcast /block /unblock` |
| Telefon ilovasi (Android/iPhone PWA, oflayn qobiq) | ✅ ; APK/AAB uchun `android/README.md` |
| Windows kompyuter dasturi (alohida oyna, online serverga ulanish) | ✅ ; `.exe` yaratish uchun `desktop/README.md` |

## "O'zi o'rganadigan shaxsiy AI" haqida halol izoh
Bu **yangi neyron tarmoq o'qitmaydi**. "Miya" — o'z SQLite bazasi: admin/foydalanuvchi o'rgatgan faktlar, 👍 bosilgan javoblar va shaxsiy xotira asosida qidirib javob beradi; 👎 javoblar ballini tushiradi. Murakkab savollar uchun Ollama (yoki mos model) ulang — shunda baza kontekst sifatida beriladi. Shaxsiy xotira shifrlangan va boshqa foydalanuvchilarga ko'rinmaydi; umumiy bazani faqat admin to'ldiradi.

Telegram'da `/chats` suhbatlarni davom ettiradi yoki o‘chirishga imkon beradi; `/projects` loyihani tanlaydi yoki `/projects add NOM` bilan yaratadi, so‘ng `/task MATN` vazifa qo‘shadi va `/tasks` bajarilganini belgilaydi. `/language` AI javoblari tilini o‘zgartiradi. Montaj uchun `/montage` yuborib, 20 MB gacha bo‘lgan rasm/video (ixtiyoriy audio musiqa) yuboring; `/montage preset vertical` yoki `/montage filter sepia` bilan sozlab, `/montage_done` bilan boshlang. `/montage_status` holatni ko‘rsatadi, `/extract_audio` esa oxirgi video/audio fayldan audio ajratadi. Telegram orqali yuklab olinadigan fayllar 20 MB bilan cheklangan; kattaroq tayyor montajni web ilovadan yuklab oling. Botga qo‘shilgan fayllar va AI suhbatlari umumiy hisobda saqlanadi.

## Himoya
- Xabarlar, suhbat sarlavhalari, qaydlar, shaxsiy xotira, **yuklangan fayllar** — AES-256-GCM bilan shifrlangan (`ENC_KEY`). Parollar — scrypt.
- Sessiya: HttpOnly + SameSite=Strict + (production) Secure; HMAC imzo; parol almashganda barcha sessiyalar yopiladi.
- CSRF: barcha o'zgartiruvchi so'rovlarda maxsus sarlavha + Origin tekshiruvi. CSP, HSTS, nosniff, frame-ancestors yopiq.
- Tezlik cheklovlari (login, ro'yxat, chat, ovoz, to'lov, umumiy API), email+IP bo'yicha bloklash, kunlik tarif limitlari.
- Fayllar: haqiqiy tur tekshiruvi (SVG/HTML/zip/exe rad), egalik nazorati, `sandbox` CSP bilan beriladi.
- Telegram: faqat shaxsiy chatlar, admin buyruqlari faqat `ADMIN_TELEGRAM_ID`, token loglarda yashiriladi.
- ffmpeg `shell`siz, argumentlar massivi bilan chaqiriladi.
- Cheklov: email va ism bazada ochiq matn (kirish uchun kerak); disk to'liq shifrlanishi (OS darajasi) sizning serveringizga bog'liq.

## Muhim: sir kalitlar
- `ENC_KEY` ni yo'qotsangiz, shifrlangan ma'lumotlarni **qayta tiklab bo'lmaydi**. Zaxira oling: `npm run backup` + `uploads/` papkasi + `.env`.
- Bot tokenini boshqalarga bermang. Agar tokeningiz yozishmada ko'rsatilgan bo'lsa — @BotFather → `/revoke` bilan yangilab, `.env` ga yangisini yozing.

## Ro'yxatdan o'tish va kirish
- Email + parol (parol siyosati: ≥10 belgi, oddiy parollar/email/ism rad etiladi, kuchlilik ko'rsatkichi), honeypot va tezlik cheklovlari.
- **Telegram orqali kirish** (email shart emas): bot kirish so'rovini IP/qurilma ma'lumoti bilan ko'rsatadi, foydalanuvchi «Ha, bu menman» ni bosadi. Havola 5 daqiqa amal qiladi, bir martalik.
- **Parolni tiklash**: kod Telegram orqali keladi (SMTP kerak emas). Telegram bog'lanmagan bo'lsa — admin vaqtincha parol beradi.

## Joylash (deploy)
To'liq yo'riqnoma: **DEPLOY.md** (`DOMAIN=... docker compose up -d --build` — HTTPS bilan).

Docker (ffmpeg, poppler o'rnatilgan): `docker build -t synaptox .` → `docker run -p 3000:3000 -v synaptox-data:/data --env-file .env synaptox`. HTTPS bering (Render/Railway/Fly/VPS+Caddy), `/data` ga doimiy disk ulang, `TRUST_PROXY=1`. Bot long polling ishlatadi — domen/webhook shart emas, lekin server `api.telegram.org` ga chiqa olishi kerak. `NODE_ENV=production` da cookie `Secure` bo'ladi, shuning uchun oddiy `http://` (localhost'dan boshqa) orqali kirib bo'lmaydi — lokal sinash uchun `NODE_ENV=development`.

## Hali yoqilmagan
- AI javobi va ovoz profildan 50+ tilda tanlanadi (nutq sifati brauzer/OS va STT provayderiga bog‘liq). Interfeys qurilma tiliga moslasha oladi; barcha 53 tilda asosiy menyu va amallar tarjima qilingan, biroq barcha sahifa matnlari har bir tilda hali to‘liq emas.
- **Click/Payme** avtomatik to‘lov: merchant hisobi va webhook imzosi kerak; hozir qo‘lda tasdiqlash oqimi bor.
- Videoni *mazmun bo'yicha* tahlil qilish (faqat montaj va audio ajratish bor).
- Tayyor APK/AAB (Android SDK kerak) — `android/README.md`.

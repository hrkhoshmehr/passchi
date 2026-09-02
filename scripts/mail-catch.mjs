/**
 * گیرندهٔ ایمیل — **فقط دریافت**، برای راستی‌آزمایی مالکیت دامنه.
 *
 * چرا این و نه یک میل‌سرور واقعی: تنها چیزی که لازم داریم گرفتنِ یک کد از
 * اینماد است. Postfix و Dovecot برای این کار مثل استفاده از جرثقیل برای
 * برداشتن یک لیوان است — و هرکدام یک سرویس دیگرند که باید نگهداری شوند.
 *
 * چیزی که این **نمی‌کند** و عمدی است:
 * • ایمیل نمی‌فرستد. پس نه SPF لازم است نه DKIM نه نگرانی از لیست سیاه.
 * • احراز هویت ندارد و هیچ‌کس نمی‌تواند از طریقش چیزی بفرستد (relay نیست) —
 *   هر تلاش برای ارسال به دامنهٔ دیگر رد می‌شود.
 * • چیزی را پاک یا بازنویسی نمی‌کند؛ فقط به یک فایل **اضافه** می‌کند.
 *
 * هر پیام خام در `data/mail/` ذخیره می‌شود. خواندنش با `mail-read.mjs`.
 *
 * اجرا (باید root باشد چون پورت ۲۵ زیر ۱۰۲۴ است):
 *   node --import tsx scripts/mail-catch.mjs
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MAIL_PORT ?? 25);
const DIR = process.env.MAIL_DIR ?? "data/mail";
/** فقط برای این دامنه ایمیل می‌پذیریم — نه هر چیزی که برسد. */
const DOMAIN = "passchi.ir";
/** سقف اندازهٔ یک پیام، تا کسی با یک اتصال دیسک را پر نکند. */
const MAX_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = net.createServer((sock) => {
  const peer = sock.remoteAddress ?? "?";
  let buf = "";
  let inData = false;
  let message = "";
  let from = "";
  const rcpt = [];
  let bytes = 0;

  const say = (line) => sock.write(line + "\r\n");
  sock.setTimeout(60_000, () => sock.destroy());
  sock.on("error", () => {});

  say(`220 ${DOMAIN} ESMTP ready`);

  sock.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      say("552 message too large");
      sock.destroy();
      return;
    }
    buf += chunk.toString("utf8");

    for (;;) {
      const nl = buf.indexOf("\r\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);

      if (inData) {
        // نقطهٔ تنها در یک خط یعنی پایان پیام (RFC 5321)
        if (line === ".") {
          inData = false;
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = path.join(DIR, `${stamp}-${Math.random().toString(36).slice(2, 8)}.eml`);
          fs.writeFileSync(file, `X-Peer: ${peer}\nX-From: ${from}\nX-To: ${rcpt.join(", ")}\n\n${message}`, "utf8");
          log(`✉️  پیام ذخیره شد: ${file} (از ${from} برای ${rcpt.join(", ")})`);
          message = "";
          say("250 OK");
        } else {
          // خطی که با نقطه شروع شود، یک نقطهٔ اضافه دارد (dot-stuffing)
          message += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        }
        continue;
      }

      const cmd = line.trim();
      const upper = cmd.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        say(`250-${DOMAIN}`);
        say("250 SIZE 5242880");
      } else if (upper.startsWith("MAIL FROM")) {
        from = cmd.slice(cmd.indexOf(":") + 1).trim();
        say("250 OK");
      } else if (upper.startsWith("RCPT TO")) {
        const to = cmd.slice(cmd.indexOf(":") + 1).trim();
        // فقط دامنهٔ خودمان — این چیزی است که جلوی open relay را می‌گیرد.
        if (!to.toLowerCase().includes(`@${DOMAIN}`)) {
          say("550 relay not permitted");
          log(`⛔ رد شد (دامنهٔ غریبه): ${to} از ${peer}`);
          continue;
        }
        rcpt.push(to);
        say("250 OK");
      } else if (upper === "DATA") {
        if (rcpt.length === 0) {
          say("503 need RCPT first");
          continue;
        }
        inData = true;
        say("354 End data with <CRLF>.<CRLF>");
      } else if (upper === "QUIT") {
        say("221 Bye");
        sock.end();
      } else if (upper === "RSET") {
        from = ""; rcpt.length = 0; message = "";
        say("250 OK");
      } else if (upper === "NOOP") {
        say("250 OK");
      } else {
        say("250 OK");
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`گیرندهٔ ایمیل روی پورت ${PORT} — پیام‌ها در ${path.resolve(DIR)}`);
});

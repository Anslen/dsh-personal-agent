import https from "node:https";
import { isIP } from "node:net";
import { load } from "cheerio";

// 每次重定向重新检查地址，并将已验证的 DNS 结果固定到本次连接，避免 DNS 重绑定。
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19))
    );
  }
  if (isIP(ip) === 6)
    return (
      /^2[0-9a-f]{3}:/i.test(ip) &&
      !/^2001:(db8|0):/i.test(ip) &&
      !/^2002:/i.test(ip)
    );
  return false;
}
export async function download(raw, maxBytes = 8 * 1024 * 1024, redirects = 0) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("仅允许标准端口的公网 HTTPS 地址");
  if (redirects > 4) throw new Error("重定向过多");
  // 本机代理启用了 Fake-IP，固定使用公网 DoH 查询真实地址，再执行公网检查。
  let addresses;
  if (isIP(url.hostname))
    addresses = [{ address: url.hostname, family: isIP(url.hostname) }];
  else {
    const response = await fetch(
      "https://cloudflare-dns.com/dns-query?name=" +
        encodeURIComponent(url.hostname) +
        "&type=A",
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error("公网 DNS 查询失败");
    const dns = await response.json();
    addresses = (dns.Answer || [])
      .filter((a) => a.type === 1)
      .map((a) => ({ address: a.data, family: 4 }));
  }
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new Error("拒绝访问非公网地址");
  const ip = addresses[0];
  const result = await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        lookup: (_host, options, cb) =>
          options?.all ? cb(null, [ip]) : cb(null, ip.address, ip.family),
        headers: {
          "user-agent": "DSH-role-stickers/1.0",
          accept: "*/*",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载HTTP ${res.statusCode}`));
          return;
        }
        if (Number(res.headers["content-length"] || 0) > maxBytes) {
          res.destroy();
          reject(new Error("文件超过大小限制"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy(new Error("文件超过大小限制"));
            return;
          }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            type: String(res.headers["content-type"] || ""),
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("下载超过20秒")),
      20000,
    );
    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));
  });
  if (result.redirect)
    return download(
      new URL(result.redirect, url).href,
      maxBytes,
      redirects + 1,
    );
  return result;
}
export function imageLinks(html, page) {
  const $ = load(html),
    out = [];
  $('meta[property="og:image"],meta[name="twitter:image"],img').each(
    (_i, el) => {
      const e = $(el);
      const raw =
        e.attr("content") ||
        e.attr("data-original") ||
        e.attr("data-src") ||
        e.attr("src");
      if (!raw) return;
      try {
        const url = new URL(raw, page);
        if (url.protocol === "http:") url.protocol = "https:";
        if (
          url.protocol === "https:" &&
          !/logo|favicon|avatar|icon|badge|qrcode/i.test(url.pathname)
        )
          out.push(url.href);
      } catch {}
    },
  );
  return [...new Set(out)].slice(0, 20);
}

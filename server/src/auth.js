// Kimlik doğrulama ters proxy'ye (IIS / nginx) bırakılır: kurumsal Windows
// ortamında zaten orada yapılır ve servise ek bağımlılık girmez. Servis yalnızca
// proxy'nin ilettiği kimlik başlığına güvenir.
//
// Bu güvenin iki koşulu var ve ikisi de burada zorlanır:
//   1. İstek gerçekten proxy'den gelmeli — kaynak adres güvenilen listede olmalı.
//   2. Proxy, istemciden gelen kimlik başlığını SİLMELİ. Aksi hâlde herhangi bir
//      kullanıcı kendi isteğine başlığı ekleyip başkası gibi görünür. Bu koşul
//      kodla zorlanamaz; proxy yapılandırmasında sağlanır (bkz. README).

import net from "node:net";

const MAX_USER_LENGTH = 256;

// IPv4-mapped IPv6 (::ffff:10.0.0.5) aynı adresin ikinci yazımıdır; iki biçim
// arasındaki fark yüzünden güvenilen proxy tanınmazlık edemez.
export function normalizeAddress(address) {
  if (!address) return "";
  const value = String(address).trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(value);
  return mapped ? mapped[1] : value;
}

function ipv4ToInteger(address) {
  return address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0) >>> 0;
}

function matcherFor(entry) {
  const [address, bits] = entry.split("/");
  if (bits === undefined) {
    if (!net.isIP(address)) throw new Error(`AUTH_TRUSTED_PROXIES geçersiz adres içeriyor: ${entry}`);
    return (candidate) => candidate === address;
  }
  if (!net.isIPv4(address)) throw new Error(`AUTH_TRUSTED_PROXIES yalnızca IPv4 için ağ maskesi destekler: ${entry}`);
  const prefix = Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`AUTH_TRUSTED_PROXIES geçersiz ağ maskesi: ${entry}`);
  }
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = ipv4ToInteger(address) & mask;
  return (candidate) => net.isIPv4(candidate) && (ipv4ToInteger(candidate) & mask) === network;
}

// Kullanıcı adı doğrudan log'a yazılıyor; satır sonu ve kontrol karakteri
// taşıyan bir değer log kaydını sahteleyebilir.
function sanitizeUser(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[\u0000-\u001F\u007F]/gu, "").trim();
  if (!clean || clean.length > MAX_USER_LENGTH) return null;
  return clean;
}

export const AUTH_RESULT = Object.freeze({
  untrustedSource: "guvenilmeyen-kaynak",
  missingIdentity: "kimlik-basligi-yok",
});

export function createAuthenticator({ mode = "none", userHeader = "x-remote-user", trustedProxies = [] } = {}) {
  if (mode === "none") {
    return { mode, required: false, authenticate: () => ({ ok: true, user: null }) };
  }
  if (mode !== "proxy") {
    throw new Error(`Bilinmeyen AUTH_MODE değeri: ${mode}. Geçerli: none, proxy.`);
  }
  if (!trustedProxies.length) {
    throw new Error("AUTH_MODE=proxy iken AUTH_TRUSTED_PROXIES boş olamaz; boş liste tüm istekleri kabul etmek anlamına gelirdi.");
  }

  const header = String(userHeader).toLowerCase();
  const matchers = trustedProxies.map(matcherFor);

  return {
    mode,
    required: true,
    userHeader: header,
    trustedProxies: [...trustedProxies],
    authenticate(request) {
      const address = normalizeAddress(request.socket?.remoteAddress);
      if (!matchers.some((matches) => matches(address))) {
        return { ok: false, user: null, address, reason: AUTH_RESULT.untrustedSource };
      }
      const user = sanitizeUser(request.headers?.[header]);
      if (!user) return { ok: false, user: null, address, reason: AUTH_RESULT.missingIdentity };
      return { ok: true, user, address };
    },
  };
}

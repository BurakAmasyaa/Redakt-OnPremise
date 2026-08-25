import assert from "node:assert/strict";
import test from "node:test";
import { AUTH_RESULT, createAuthenticator, normalizeAddress } from "../server/src/auth.js";

const request = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });

test("kimlik doğrulama kapalıyken istek olduğu gibi geçer", () => {
  const auth = createAuthenticator({ mode: "none" });
  assert.equal(auth.required, false);
  assert.deepEqual(auth.authenticate(request("10.0.0.9")), { ok: true, user: null });
});

test("yapılandırma hataları sessizce açık bırakmaz", () => {
  // Boş liste "herkese güven" demek olurdu; servis hiç başlamamalı.
  assert.throws(() => createAuthenticator({ mode: "proxy", trustedProxies: [] }), /boş olamaz/u);
  assert.throws(() => createAuthenticator({ mode: "acik" }), /Bilinmeyen AUTH_MODE/u);
  assert.throws(() => createAuthenticator({ mode: "proxy", trustedProxies: ["sunucu.local"] }), /geçersiz adres/u);
  assert.throws(() => createAuthenticator({ mode: "proxy", trustedProxies: ["10.0.0.0/33"] }), /ağ maskesi/u);
});

test("yalnızca güvenilen proxy'den gelen istek kabul edilir", () => {
  const auth = createAuthenticator({ mode: "proxy", trustedProxies: ["10.0.5.0/24", "127.0.0.1"] });

  assert.deepEqual(
    auth.authenticate(request("10.0.5.7", { "x-remote-user": "SIRKET\\burak" })),
    { ok: true, user: "SIRKET\\burak", address: "10.0.5.7" }
  );
  // Kural listesini doğrudan çekmeye çalışan ağdaki başka bir makine.
  assert.equal(auth.authenticate(request("10.0.9.4", { "x-remote-user": "burak" })).reason, AUTH_RESULT.untrustedSource);
  // Proxy'den geldi ama kimlik başlığı yok — proxy yanlış yapılandırılmış.
  assert.equal(auth.authenticate(request("127.0.0.1")).reason, AUTH_RESULT.missingIdentity);
  assert.equal(auth.authenticate(request("127.0.0.1", { "x-remote-user": "   " })).reason, AUTH_RESULT.missingIdentity);
});

test("IPv4-mapped IPv6 yazımı güvenilen proxy'yi tanınmaz kılmaz", () => {
  const auth = createAuthenticator({ mode: "proxy", trustedProxies: ["10.0.5.7"] });
  assert.equal(normalizeAddress("::ffff:10.0.5.7"), "10.0.5.7");
  assert.equal(auth.authenticate(request("::ffff:10.0.5.7", { "x-remote-user": "burak" })).ok, true);
});

test("kullanıcı adı log kaydını sahteleyemez", () => {
  const auth = createAuthenticator({ mode: "proxy", trustedProxies: ["127.0.0.1"] });
  const result = auth.authenticate(request("127.0.0.1", { "x-remote-user": "burak\n2026-01-01 ERROR sahte kayit" }));
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.user, /[\r\n]/u);
  // Aşırı uzun değer reddedilir.
  assert.equal(auth.authenticate(request("127.0.0.1", { "x-remote-user": "a".repeat(300) })).ok, false);
});

test("başlık adı yapılandırılabilir ve büyük-küçük harf duyarsızdır", () => {
  const auth = createAuthenticator({ mode: "proxy", trustedProxies: ["127.0.0.1"], userHeader: "X-Kullanici" });
  assert.equal(auth.userHeader, "x-kullanici");
  // Node gelen başlık adlarını küçük harfe çevirir.
  assert.equal(auth.authenticate(request("127.0.0.1", { "x-kullanici": "burak" })).user, "burak");
  assert.equal(auth.authenticate(request("127.0.0.1", { "x-remote-user": "burak" })).ok, false);
});

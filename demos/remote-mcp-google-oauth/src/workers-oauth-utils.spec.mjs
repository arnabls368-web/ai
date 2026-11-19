import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCSRFProtection,
  renderApprovalDialog,
  sanitizeText,
  sanitizeUrl,
  validateCSRFToken,
} from "./workers-oauth-utils.ts";

test("sanitizeText escapes HTML metacharacters used in approval content", () => {
  assert.equal(
    sanitizeText(`<script>alert("x") & 'y'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;) &amp; &#039;y&#039;&lt;/script&gt;",
  );
});

test("sanitizeUrl permits web URLs and rejects executable or malformed schemes", () => {
  assert.equal(sanitizeUrl("https://client.example/privacy"), "https://client.example/privacy");
  assert.equal(sanitizeUrl("http://client.example"), "http://client.example");
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(sanitizeUrl("file:///etc/passwd"), "");
  assert.equal(sanitizeUrl("https://client.example/\nInjected: value"), "");
});

test("CSRF protection issues secure host cookie and accepts only its matching form token", () => {
  const { token, setCookie } = generateCSRFProtection();
  assert.match(setCookie, /^__Host-CSRF_TOKEN=[0-9a-f-]+; HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=600$/);

  const request = new Request("https://worker.example/authorize", {
    headers: { Cookie: setCookie.split(";")[0] },
  });
  const form = new FormData();
  form.set("csrf_token", token);
  const { clearCookie } = validateCSRFToken(form, request);
  assert.match(clearCookie, /Max-Age=0/);

  const mismatched = new FormData();
  mismatched.set("csrf_token", "attacker-token");
  assert.throws(() => validateCSRFToken(mismatched, request), /CSRF token mismatch/);
});

test("approval dialog safely escapes client metadata and blocks unsafe links", async () => {
  const response = renderApprovalDialog(
    new Request("https://worker.example/authorize?client=untrusted"),
    {
      client: {
        clientName: '<img src=x onerror="alert(1)">',
        clientUri: "javascript:alert(1)",
        policyUri: "https://client.example/privacy?x=1&y=2",
        tosUri: "data:text/html,unsafe",
        contacts: ['<svg onload="alert(1)">'],
        redirectUris: ["https://client.example/callback", "javascript:alert(1)"],
      },
      server: {
        name: '<script>alert("server")</script>',
        description: "Review access before continuing",
      },
      encodedState: '" onfocus="alert(1)',
      csrfToken: '" autofocus onfocus="alert(2)',
      setCookie: "__Host-CSRF_TOKEN=csrf-token; HttpOnly; Secure; Path=/; SameSite=Lax",
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  const html = await response.text();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;server&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /data:text\/html/);
  assert.match(html, /https:\/\/client\.example\/privacy\?x=1&amp;y=2/);
  assert.match(html, /https:\/\/client\.example\/callback/);
  assert.match(html, /name="state" value="&quot; onfocus=&quot;alert\\(1\\)"/);
  assert.match(html, /name="csrf_token" value="&quot; autofocus onfocus=&quot;alert\\(2\\)"/);
  assert.doesNotMatch(html, /value="[^"]*" onfocus=/);
});

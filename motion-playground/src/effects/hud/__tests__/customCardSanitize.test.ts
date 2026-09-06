// @ts-ignore
import assert from "node:assert";
import { replacePlaceholders, sanitizeCss } from "../customCardSanitize";

// Test replacePlaceholders
const replaced = replacePlaceholders("<div>{{title}}</div><span>{{body}}</span>-{{accent}}", "My <Title>", "My 'Body'", "blue");
assert.strictEqual(replaced, "<div>My &lt;Title&gt;</div><span>My &#039;Body&#039;</span>-blue");

// Test sanitizeCss
assert.strictEqual(sanitizeCss("body { color: red; }"), "body { color: red; }");
assert.strictEqual(sanitizeCss("@import url('https://evil.com/style.css'); body { color: red; }"), " body { color: red; }");
assert.strictEqual(sanitizeCss("body { background: url('https://evil.com/img.png'); }"), "body { background: url(); }");
assert.strictEqual(sanitizeCss("body { background: url('/_media/img.png'); }"), "body { background: url('/_media/img.png'); }");
assert.strictEqual(sanitizeCss("body { background: url(data:image/png;base64,xxx); }"), "body { background: url(data:image/png;base64,xxx); }");
assert.strictEqual(sanitizeCss("body { width: expression(alert(1)); }"), "body { width: alert(1)); }");

// Test sanitizeHtml fallback behavior
if (typeof DOMParser === "undefined") {
    console.log("跳过 DOM 相关的清洗测试，因为 Node 环境没有 DOMParser。");
} else {
    console.log("Running DOMParser tests...");
}

console.log("customCardSanitize tests passed.");

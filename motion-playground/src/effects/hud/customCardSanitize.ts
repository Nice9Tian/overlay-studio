const ALLOWED_TAGS = new Set([
  "div", "span", "p", "b", "i", "em", "strong", "u", "s", "small", "sup", "sub", "br", "hr",
  "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "code", "pre", "img",
  "svg", "path", "circle", "rect", "line", "g", "text"
]);

const ALLOWED_ATTRS = new Set([
  "class", "style", "src", "alt", "viewbox", "d", "cx", "cy", "r", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "fill", "stroke", "stroke-width"
]);

export function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export function replacePlaceholders(template: string, title: string, body: string, accent: string) {
    return template
        .replace(/\{\{title\}\}/g, escapeHtml(title))
        .replace(/\{\{body\}\}/g, escapeHtml(body))
        .replace(/\{\{accent\}\}/g, accent);
}

export function sanitizeCss(css: string) {
    let safe = css.replace(/@import\b[^;]+;/gi, "");
    safe = safe.replace(/expression\s*\(/gi, "");
    safe = safe.replace(/url\(\s*['"]?(.*?)['"]?\s*\)/gi, (match, url) => {
        const trimmed = url.trim();
        if (trimmed.startsWith('/') || trimmed.startsWith('data:image/')) {
            return match;
        }
        return 'url()';
    });
    return safe;
}

export function sanitizeHtml(html: string): string {
    if (typeof DOMParser === "undefined") {
        return html;
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    function walk(node: Node) {
        if (node.nodeType === 1) { // Element
            const el = node as Element;
            const tag = el.tagName.toLowerCase();
            if (!ALLOWED_TAGS.has(tag)) {
                el.parentNode?.removeChild(el);
                return;
            }
            
            const attrs = Array.from(el.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                if (!ALLOWED_ATTRS.has(name) || name.startsWith("on")) {
                    el.removeAttribute(attr.name);
                    continue;
                }
                
                const val = attr.value.trim();
                if (val.toLowerCase().startsWith("javascript:")) {
                    el.removeAttribute(attr.name);
                    continue;
                }
                
                if (name === "src" && tag === "img") {
                    if (!val.startsWith("/_media/") && !val.startsWith("/") && !val.startsWith("data:image/")) {
                        el.removeAttribute(attr.name);
                    }
                }
            }
            
            Array.from(el.childNodes).forEach(walk);
        } else if (node.nodeType !== 3) { // Not Text
            node.parentNode?.removeChild(node);
        }
    }
    
    Array.from(doc.body.childNodes).forEach(walk);
    return doc.body.innerHTML;
}

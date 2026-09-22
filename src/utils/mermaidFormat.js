/**
 * mermaidFormat — shared mermaid pipeline helpers for the renderer.
 *
 * UMD: loads as a <script> in the Electron renderer (window.MermaidFormat)
 * and via require() in node for the test suite. Pure string functions —
 * no DOM access — so both environments can use them directly.
 *
 * Pipeline: model markdown -> closeUnclosedMermaidFence -> marked.parse ->
 * mermaidBlocksToDivs -> debounce in AssistantView -> sanitizeMermaidCode ->
 * window.mermaid.render.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MermaidFormat = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function decodeEntities(code) {
        return String(code)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"');
    }

    function encodeDiagram(code) {
        // btoa is global in both browsers and node >= 16.
        return btoa(unescape(encodeURIComponent(code)));
    }

    function decodeDiagram(encoded) {
        return decodeURIComponent(escape(atob(encoded)));
    }

    /**
     * Convert marked's <pre><code class="language-mermaid"> blocks into
     * <div class="mermaid" data-code="base64"> placeholders that the
     * debounced renderer in AssistantView picks up. Case-insensitive so
     * ```Mermaid / ```MERMAID fences work too.
     */
    function mermaidBlocksToDivs(html) {
        return String(html || '').replace(
            /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
            function (_, code) {
                return '<div class="mermaid" data-code="' + encodeDiagram(decodeEntities(code)) + '"></div>';
            }
        );
    }

    /**
     * If streaming was cut off mid-diagram the ```mermaid fence never closes;
     * marked then swallows the whole block as a paragraph and no diagram
     * renders. Auto-close a trailing UNCLOSED mermaid fence so a partial
     * diagram still renders (it re-renders as more chunks arrive). Leaves
     * already-closed fences and non-mermaid fences untouched.
     */
    function closeUnclosedMermaidFence(markdown) {
        var content = String(markdown || '');
        if (content.indexOf('```') === -1) return content;
        var opens = content.match(/```/g).length;
        if (opens % 2 === 0) return content; // all fences closed
        var lastFence = content.lastIndexOf('```');
        var after = content.slice(lastFence + 3);
        if (/^\s*mermaid\b/i.test(after)) return content + '\n```';
        return content;
    }

    /**
     * Decode a data-code payload and apply the line sanitizers that keep
     * real-world model output parseable by mermaid 10 (subgraph names,
     * arrow styles, unquoted labels with special chars, nested quotes).
     * Returns the cleaned diagram source.
     */
    function sanitizeMermaidCode(encoded) {
        var raw = decodeDiagram(encoded);
        return raw
            .replace(/```\s*"?\s*$/, '')
            .trim()
            .split('\n')
            .map(function (line) {
                // Strip &amp; artifacts from subgraph names (subgraph Data & Async → subgraph Data and Async)
                line = line.replace(/^(\s*subgraph\s+)(.*)$/g, function (_, prefix, name) {
                    var clean = name.replace(/&/g, 'and').replace(/[^a-zA-Z0-9 _-]/g, '');
                    return prefix + clean.trim();
                });
                // Convert dotted arrows -.-> or -. text .-> to solid arrows -->
                line = line.replace(/\s*-\..*?\.?->\s*/g, ' --> ');
                // Convert thick arrows ==> to solid arrows -->
                line = line.replace(/\s*==+>\s*/g, ' --> ');
                // Quote unquoted bracket labels containing special chars: / ( ) : & ;
                line = line.replace(/\[([^\]"]*[\/\(\):&;][^\]"]*)\]/g, function (_, l) { return '["' + l + '"]'; });
                // Fix already-quoted labels with nested quotes (non-greedy: one label at a time)
                line = line.replace(/\["(.+?)"\]/g, function (_, l) { return '["' + l.replace(/"/g, '') + '"]'; });
                // Fix parenthesized labels (round shapes)
                line = line.replace(/\("(.+?)"\)/g, function (_, l) { return '("' + l.replace(/"/g, '') + '")'; });
                // Quote participant lines with special chars
                line = line.replace(/^(\s*participant\s+)([^"\n]*[\/\(\)\.][^"\n]*)$/g, function (_, p, name) { return p + '"' + name.trim() + '"'; });
                return line;
            })
            .join('\n');
    }

    return {
        mermaidBlocksToDivs: mermaidBlocksToDivs,
        closeUnclosedMermaidFence: closeUnclosedMermaidFence,
        sanitizeMermaidCode: sanitizeMermaidCode,
        decodeDiagram: decodeDiagram,
    };
});

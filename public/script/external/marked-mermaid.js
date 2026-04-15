// Marked.js extension for Mermaid diagrams
function markedMermaid(options) {
  options = options || {};
  
  return {
    extensions: [
      {
        name: 'mermaid',
        level: 'block',
        start(src) {
          return src.match(/^```mermaid/m)?.index;
        },
        tokenizer(src, tokens) {
          const rule = /^```mermaid\n([\s\S]*?)\n```/;
          const match = rule.exec(src);
          if (match) {
            return {
              type: 'mermaid',
              raw: match[0],
              text: match[1].trim()
            };
          }
        },
        renderer(token) {
          const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
          
          // Initialize Mermaid if not already done
          if (typeof mermaid !== 'undefined' && !window.mermaidInitialized) {
            mermaid.initialize({ 
              startOnLoad: false,
              theme: 'default',
              securityLevel: 'loose'
            });
            window.mermaidInitialized = true;
          }
          
          // Create a div that will be processed by Mermaid
          const div = `<div class="mermaid" id="${id}">${token.text}</div>`;
          
          // Schedule Mermaid rendering for after DOM insertion
          setTimeout(() => {
            if (typeof mermaid !== 'undefined') {
              try {
                const element = document.getElementById(id);
                if (element && !element.getAttribute('data-processed')) {
                  mermaid.init(undefined, element);
                  element.setAttribute('data-processed', 'true');
                }
              } catch (error) {
                console.error('Mermaid rendering error:', error);
              }
            }
          }, 0);
          
          return div;
        }
      }
    ]
  };
}

// Make it available globally
if (typeof window !== 'undefined') {
  window.markedMermaid = markedMermaid;
}

// CommonJS/Node.js export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = markedMermaid;
} 
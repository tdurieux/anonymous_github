const defaultOptions = {
  // emojis: {}, required
  unicode: false,
};

function markedEmoji(options) {
  options = {
    ...defaultOptions,
    ...options,
  };

  if (!options.emojis) {
    throw new Error("Must provide emojis to markedEmoji");
  }

  return {
    extensions: [
      {
        name: "emoji",
        level: "inline",
        start(src) {
          return src.indexOf(":");
        },
        tokenizer(src, tokens) {
          const rule = /^:(.+?):/;
          const match = rule.exec(src);
          if (!match) {
            return;
          }

          const name = match[1];
          const emoji = options.emojis[name];

          if (!emoji) {
            return;
          }

          return {
            type: "emoji",
            raw: match[0],
            name,
            emoji,
          };
        },
        renderer(token) {
          if (options.unicode) {
            return token.emoji;
          } else {
            return `<img class="emoji" alt="${token.name}" src="${
              token.emoji
            }"${this.parser.options.xhtml ? " /" : ""}>`;
          }
        },
      },
    ],
  };
}

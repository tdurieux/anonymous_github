function humanFileSize(bytes, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  bytes = bytes / 8;

  if (Math.abs(bytes) < thresh) {
    return bytes + "B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  );

  return bytes.toFixed(dp) + "" + units[u];
}

function urlRel2abs(
  url,
  baseUrl = location.href.match(/^(.+)\/?(?:#.+)?$/)[0] + "/"
) {
  /* Only accept commonly trusted protocols:
   * Only data-image URLs are accepted, Exotic flavours (escaped slash,
   * html-entitied characters) are not supported to keep the function fast */
  if (
    /^(https?|file|ftps?|mailto|javascript|data:image\/[^;]{2,9};):/i.test(url)
  ) {
    return url; //Url is already absolute
  }

  if (url.substring(0, 2) == "//") return location.protocol + url;
  else if (url.charAt(0) == "/") return baseUrl + url;
  else if (url.substring(0, 2) == "./") url = "." + url;
  else if (/^\s*$/.test(url)) return "";
  //Empty = Return nothing

  url = baseUrl + url;

  while (/\/\.\.\//.test((url = url.replace(/[^\/]+\/+\.\.\//g, ""))));
  /* Escape certain characters to prevent XSS */
  url = url
    .replace(/\.$/, "")
    .replace(/\/\.\//g, "")
    .replace(/"/g, "%22")
    .replace(/'/g, "%27")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");

  return url;
}

const charactersAttributes = "[^-a-z0-9:._]";
const allTagCharacters = "(?:[^>\"']*(?:\"[^\"]*\"|'[^']*'))*?[^>]*";

function by(baseUrl) {
  return (match, group1, group2, group3) => {
    /* Note that this function can also be used to remove links:
     * return group1 + "javascript://" + group3; */
    return group1 + urlRel2abs(group2, baseUrl) + group3;
  };
}

function cr(html, selector, attribute, baseUrl) {
  if (typeof selector == "string") selector = new RegExp(selector, "gi");
  attribute = charactersAttributes + attribute;
  const marker = "\\s*=\\s*";
  const end = ")(";
  var re1 = new RegExp("(" + attribute + marker + '")([^"]+)()', "gi");
  var re2 = new RegExp("(" + attribute + marker + "')([^']+)()", "gi");
  var re3 = new RegExp(
    "(" + attribute + marker + ")([^\"'][^\\s>]*" + end + ")",
    "gi"
  );
  html = html.replace(selector, function (match) {
    return match
      .replace(re1, by(baseUrl))
      .replace(re2, by(baseUrl))
      .replace(re3, by(baseUrl));
  });
  return html;
}

function contentAbs2Relative(content, baseUrl) {
  if (!content) return content;
  content = cr(
    content,
    "<" +
      allTagCharacters +
      charactersAttributes +
      "href\\s*=" +
      allTagCharacters +
      ">",
    "href",
    baseUrl
  );
  content = cr(
    content,
    "<" +
      allTagCharacters +
      charactersAttributes +
      "src\\s*=" +
      allTagCharacters +
      ">",
    "src",
    baseUrl
  );
  return content;
}

function generateRandomId(length) {
  const alphabet = "ABCDEF0123456789";
  let output = "";
  for (let index = 0; index < length; index++) {
    output += alphabet[Math.round(Math.random() * (alphabet.length - 1))];
  }
  return output;
}

function parseGithubUrl(url) {
  if (!url) throw "Invalid url";
  const matches = url
    .replace(".git", "")
    .match(
      /.*?github.com\/(?<owner>[\w-\._]+)\/(?<repo>[\w-\._]+)(\/pull\/(?<PR>[0-9]+))?/
    );
  if (matches && matches.groups.owner && matches.groups.repo) {
    return {
      owner: matches.groups.owner,
      repo: matches.groups.repo,
      pullRequestId: matches.groups.PR,
    };
  } else {
    throw "Invalid url";
  }
}

function renderMD(md, baseUrlValue) {
  marked.use(
    markedEmoji({
      emojis: githubEmojis,
      unicode: false,
    })
  );
  md = contentAbs2Relative(md, baseUrlValue);
  const renderer = new marked.Renderer();

  const rendererLink = renderer.link;
  renderer.link = function (href, title, text) {
    // wrap videos links (mp4 and mov) with media https://github.blog/2021-05-13-video-uploads-available-github/
    if (href.match(/\.mp4$|\.mov$/)) {
      return `<div class="media"><video controls title="${title}" src="${href}">${text}</video></div>`;
    }
    return rendererLink.call(this, href, title, text);
  };

  marked.setOptions({
    renderer: renderer,
    pedantic: false,
    gfm: true,
    breaks: false,
    sanitize: false,
    smartLists: true,
    smartypants: false,
    xhtml: false,
    headerIds: false,
    katex: katex,
  });
  if (baseUrlValue) {
    marked.use(baseUrl(baseUrlValue));
  }
  marked.use(
    markedKatex({
      throwOnError: false,
    })
  );
  return marked.parse(md, { renderer });
}

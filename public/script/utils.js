function loadFilterPrefs(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveFilterPrefs(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* localStorage unavailable or quota exceeded */
  }
}

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
  // Strip the leading "./" so it concatenates cleanly with baseUrl. The old
  // code prepended an extra "." here, which turned "./X" into "../X" and
  // silently dropped one path segment — see #346.
  else if (url.substring(0, 2) == "./") url = url.substring(2);
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
  // Gist URLs: https://gist.github.com/<owner>/<gistId> or
  // https://gist.github.com/<gistId>
  const gistMatch = url.match(
    /gist\.github\.com\/(?:(?<owner>[\w-\._]+)\/)?(?<gist>[a-fA-F0-9]+)/
  );
  if (gistMatch && gistMatch.groups.gist) {
    return {
      owner: gistMatch.groups.owner,
      gistId: gistMatch.groups.gist,
    };
  }
  const matches = url
    .replace(/\.git(\/|$)/, "$1")
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

// GitHub-style heading slug: lowercase, drop punctuation other than `-_`,
// collapse runs of whitespace into a single dash. Used so anchor links like
// `[Releases](#releases-and-contributing)` actually jump to the heading
// (marked v12 dropped `headerIds`, so headings now have no id by default).
function slugifyHeading(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
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

  const slugCounts = {};
  renderer.heading = function (text, level, raw) {
    const base = slugifyHeading(raw || text);
    const n = slugCounts[base] || 0;
    slugCounts[base] = n + 1;
    const id = n === 0 ? base : `${base}-${n}`;
    return `<h${level} id="${id}">${text}</h${level}>\n`;
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
  marked.use(markedMermaid());
  return DOMPurify.sanitize(marked.parse(md, { renderer }));
}

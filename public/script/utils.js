function urlRel2abs(url) {
  /* Only accept commonly trusted protocols:
   * Only data-image URLs are accepted, Exotic flavours (escaped slash,
   * html-entitied characters) are not supported to keep the function fast */
  if (
    /^(https?|file|ftps?|mailto|javascript|data:image\/[^;]{2,9};):/i.test(url)
  ) {
    return url; //Url is already absolute
  }
  var base_url = location.href.match(/^(.+)\/?(?:#.+)?$/)[0] + "/";

  if (url.substring(0, 2) == "//") return location.protocol + url;
  else if (url.charAt(0) == "/")
    return location.protocol + "//" + location.host + url;
  else if (url.substring(0, 2) == "./") url = "." + url;
  else if (/^\s*$/.test(url)) return "";
  //Empty = Return nothing
  else url = "../" + url;

  url = base_url + url;

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

function by(match, group1, group2, group3) {
  /* Note that this function can also be used to remove links:
   * return group1 + "javascript://" + group3; */
  return group1 + urlRel2abs(group2) + group3;
}

function cr(html, selector, attribute) {
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
    return match.replace(re1, by).replace(re2, by).replace(re3, by);
  });
  return html;
}

function contentAbs2Relative(content) {
  if (!content) return content;
  content = cr(
    content,
    "<" +
      allTagCharacters +
      charactersAttributes +
      "href\\s*=" +
      allTagCharacters +
      ">",
    "href"
  );
  content = cr(
    content,
    "<" +
      allTagCharacters +
      charactersAttributes +
      "src\\s*=" +
      allTagCharacters +
      ">",
    "src"
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

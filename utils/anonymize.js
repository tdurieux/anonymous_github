const fs = require("fs").promises;
const ofs = require("fs");
const path = require("path");
const fileUtils = require("./file");

const anonymizeContent = (content, repoConfig) => {
  const urlRegex = /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;

  if (repoConfig.options.image === false) {
    // remove image in markdown
    content = content.replace(
      /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
      ""
    );
  }

  if (!repoConfig.options.link) {
    // remove all links
    content = content.replace(urlRegex, "XXX");
  }

  content = content.replace(
    new RegExp(
      `https://github.com/${repoConfig.fullName}/blob/${repoConfig.branch}\\b`,
      "gi"
    ),
    `https://anonymous.4open.science/r/${repoConfig.repoId}`
  );
  content = content.replace(
    new RegExp(
      `https://github.com/${repoConfig.fullName}/tree/${repoConfig.branch}\\b`,
      "gi"
    ),
    `https://anonymous.4open.science/r/${repoConfig.repoId}`
  );
  content = content.replace(
    new RegExp(`https://github.com/${repoConfig.fullName}`, "gi"),
    `https://anonymous.4open.science/r/${repoConfig.repoId}`
  );

  for (let term of repoConfig.terms) {
    if (term.trim() == "") {
      continue;
    }
    // remove whole url if it contains the term
    content = content.replace(urlRegex, (match) => {
      if (new RegExp(`\\b${term}\\b`, "gi").test(match)) return "XXX";
      return match;
    });

    // remove the term in the text
    content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), "XXX");
  }
  return content;
};

const anonymizePath = (path, repoConfig) => {
  for (let term of repoConfig.terms) {
    if (term.trim() == "") {
      continue;
    }
    path = path.replace(new RegExp(term, "gi"), "XXX");
  }
  return path;
};

async function* walk(dir) {
  for await (const d of await fs.opendir(dir)) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) yield* await walk(entry);
    else if (d.isFile()) yield entry;
  }
}

const anonymizeFolder = async (root, destination, repoConfig) => {
  if (!ofs.existsSync(destination)) {
    await fs.mkdir(destination, { recursive: true });
  }
  try {
    for await (const originalFilePath of walk(root)) {
      const destinationFilePath = path.join(
        destination,
        anonymizePath(originalFilePath.replace(root, ""), repoConfig)
      );
      const destinationFolder = path.dirname(destinationFilePath);
      if (!ofs.existsSync(destinationFolder)) {
        await fs.mkdir(destinationFolder, { recursive: true });
      }
      await anonymizeFile(originalFilePath, destinationFilePath, repoConfig);
    }
  } catch (error) {
    fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
};

const anonymizeFile = async (filePath, target, repoConfig) => {
  if (!ofs.existsSync(path.dirname(target))) {
    await fs.mkdir(path.dirname(target), { recursive: true });
  }
  if (fileUtils.isText(filePath)) {
    const content = anonymizeContent(
      (await fs.readFile(filePath)).toString(),
      repoConfig
    );
    await fs.writeFile(target, content);
  } else {
    await fs.copyFile(filePath, target);
  }
};

module.exports.anonymizeFile = anonymizeFile;
module.exports.anonymizePath = anonymizePath;
module.exports.anonymizeFolder = anonymizeFolder;
module.exports.anonymizeContent = anonymizeContent;

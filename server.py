import argparse
import uuid
import json
import socket
import os
try:
    from urllib import quote  # Python 2.X
except ImportError:
    from urllib.parse import quote  # Python 3+
import re
import shutil
import string
import base64
from datetime import datetime

# non standards, in requirements.txt
from flask import Flask, request, Markup, render_template, redirect, url_for, send_from_directory
from flask_gzip import Gzip
import github   


def clean_github_repository(repo):
    """
    get the username/repository from a Github url
    :param repo:str the Github url of the repository
    :return: username/repository
    """
    if repo is None:
        return None
    repo = repo.replace("http://github.com/", "") \
        .replace("https://github.com/", "")
    if repo[-1] == '/':
        repo = repo[:-1]
    split_repo = repo.split("/")
    (username, repository) = split_repo[0:2]
    branch = "master"
    if len(split_repo) > 2:
        if split_repo[2] == "tree":
            branch = split_repo[3]
    return username, repository, branch

TEXT_CHARACTERS = ''.join([chr(code) for code in range(32,127)] + list('\b\f\n\r\t'))
def istext(s, threshold=0.30):
    if type(s) != str:
        s = s.decode('utf8')
    # if s contains any null, it's not text:
    if '\x00' in s:
        return False
    # an "empty" string is "text" (arbitrary but reasonable choice):
    if not s:
        return True
    
    binary_length = 0
    try:
        binary_length = float(len(s.translate(None, TEXT_CHARACTERS)))
    except TypeError:
        print("error")
        translate_table = dict((ord(char), None) for char in TEXT_CHARACTERS)
        binary_length = float(len(s.translate(str.maketrans(translate_table))))
    # s is 'text' if less than 30% of its characters are non-text ones:
    return binary_length/len(s) <= threshold


class Anonymous_Github:
    def __init__(self,
                 github_token,
                 host="127.0.0.1",
                 port=5000,
                 config_dir='./repositories'):
        self.github_token = github_token if github_token != "" else os.environ["GITHUB_AUTH_TOKEN"]
        self.host = host
        self.port = port
        self.config_dir = config_dir
        if config_dir[0:2] == "./":
            self.config_dir = os.path.join(os.path.dirname(os.path.realpath(__file__)), config_dir[2:])
        if not os.path.exists(self.config_dir):
            os.makedirs(self.config_dir)
        self.application = self.create_flask_application()
        self.set_public_url()
        self.github = github.Github(login_or_token=self.github_token)

    def set_public_url(self):
        if self.host == "0.0.0.0":
            self.public_url = "http://" + socket.getfqdn() + ":" + str(self.port)
        else:
            self.public_url = self.host
        if self.public_url[-1] == '/':
            self.public_url = self.public_url[0:-1]

    def create_flask_application(self):
        application = Flask(__name__)
        gzip = Gzip(application)
        application.log = {}
        application.killurl = str(uuid.uuid4())
        application.jinja_env.add_extension('jinja2.ext.do')

        @application.template_filter('remove_terms', )
        def remove_terms(content, repository_configuration, word_boundaries=True, whole_urls=True):
            """
            remove the blacklisted terms from the content
            :param content: the content to anonymize
            :param repository_configuration: the configuration of the repository
            :return: the anonimized content
            """
            repo = repository_configuration['repository']
            if repo[-1] == '/':
                repo = repo[0:-1]
            content = re.compile("%s/blob/master" % repo, re.IGNORECASE).sub(
                "%s/repository/%s" % (self.public_url, repository_configuration["id"]), content)
            content = re.compile(repo, re.IGNORECASE).sub("%s/repository/%s" % (self.public_url, repository_configuration["id"]), content)
            for term in repository_configuration['terms']:
                if word_boundaries:
                    regex = re.compile(r'\b%s\b' % term, re.IGNORECASE)
                else:
                    regex = re.compile(term, re.IGNORECASE)

                if whole_urls:
                    def sub_url(m):
                        if regex.search(m.group(0)):
                            return 'XXX'
                        return m.group(0)

                    url_regex = re.compile('\\b((https?|ftp|file)://)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\\b')
                    content = url_regex.sub(sub_url, content)

                content = regex.sub("XXX", content)
            return content

        @application.template_filter('file_render', )
        def file_render(file, repository_configuration):
            """
            produce the html representation of a file
            :param file: the file to display
            :param repository_configuration: the configuration of the repository
            :return: the html representation of the file
            """
            if type(file) == github.Commit.Commit:
                return Markup(remove_terms(render_template('patch.html', patch=file), repository_configuration))
            if file.type == 'dir':
                return ""
            if file.size > 1000000:
                return Markup("The file %s is too big to be anonymized (beyond 1MB, Github limit)" % (file.name))
            if ".md" in file.name or file.name == file.name.upper() or "changelog" == file.name.lower():
                return Markup("<div class='markdown-body'>%s</div>" % remove_terms(
                    self.github.render_markdown(file.decoded_content.decode('utf-8')),
                    repository_configuration))
            if ".jpg" in file.name or ".png" in file.name or ".png" in file.name or ".gif" in file.name:
                return Markup("<img src='%s' alt='%s'>" % (file.url, file.name))
            if istext(file.decoded_content):
                return Markup("<pre><code>{}</code></pre>")\
                           .format(Markup.escape(remove_terms(file.decoded_content.decode("utf-8"), repository_configuration)))
            return Markup("<b>%s has an unknown extension, we are unable to anonymize it (known extensions md/txt/json/java/...)</b>" % (file.name))

        @application.route('/' + application.killurl, methods=['POST'])
        def seriouslykill():
            func = request.environ.get('werkzeug.server.shutdown')
            func()
            return "Shutting down..."

        def get_element_from_path(g_repo, g_commit, path):
            """
            get a github element from its path
            :param g_repo: the github repository
            :param path: the path of the element
            :return: the element
            """
            if path == '':
                return g_repo.get_contents('', g_commit.sha), None
            current_element = os.path.basename(path)
            folder_content = g_repo.get_contents(quote(os.path.dirname(path)), g_commit.sha)
            for file in folder_content:
                if file.name == current_element:
                    return file, folder_content
            return None, folder_content

        @application.route('/repository/<id>/commit/<sha>', methods=['GET'])
        def commit(id, sha):
            """
            display anonymously a commit from the repository
            :param id: the repository id
            :param sha: the commit id
            """
            config_path = self.config_dir + "/" + str(id) + "/config.json"
            if not os.path.exists(config_path):
                return render_template('404.html'), 404
            with open(config_path) as f:
                data = json.load(f)
                (username, repo, branch) = clean_github_repository(data['repository'])
                g_repo = self.github.get_repo("%s/%s" % (username, repo))
                commit = g_repo.get_commit(sha)
                return render_template('repo.html',
                                   repository=data,
                                   current_repository=id,
                                   current_file=commit,
                                   files=[],
                                   path=[])

        def is_up_to_date(repository_config, g_commit):
            """
            check is the cache is up to date
            :param repository_config: the repository configuration
            :param g_commit: the Github commit
            :return: True if the cache is up to date
            """
            commit_date = datetime.strptime(g_commit.last_modified, "%a, %d %b %Y %H:%M:%S %Z")
            return 'pushed_at' in repository_config and commit_date.strftime("%s") == repository_config["pushed_at"]

        def get_type_content(file_name, path, repository_configuration, g_repo, is_website):
            """
            Get the content type of a file from its extension
            :param file_name: the filename
            :param path: the path of the file
            :param repository_configuration: the repository configuration
            :param g_repo: the Github repository
            :return: the content type
            """
            if is_website:
                content_type = 'text/plain; charset=utf-8'
                if ".html" in file_name:
                    content_type = 'text/html; charset=utf-8'
                if ".md" in file_name or file_name == file_name.upper():
                    content_type = 'text/html; charset=utf-8'
                if ".jpg" in file_name \
                        or ".png" in file_name \
                        or ".gif" in file_name:
                    content_type = 'image/jpeg'
                    if ".png" in file_name:
                        content_type = 'image/png'
                    elif ".gif" in file_name:
                        content_type = 'image/gif'
                if ".txt" in file_name \
                        or ".log" in file_name \
                        or ".csv" in file_name \
                        or ".xml" in file_name \
                        or ".json" in file_name \
                        or ".java" in file_name \
                        or ".py" in file_name \
                        or ".lua" in file_name \
                        or ".js" in file_name:
                    content_type = 'text/plain; charset=utf-8'
                    if ".xml" in file_name:
                        content_type = 'application/xml; charset=utf-8'
                    elif ".json" in file_name:
                        content_type = 'application/json; charset=utf-8'
                    elif ".js" in file_name:
                        content_type = 'application/javascript; charset=utf-8'
                if ".css" in file_name:
                    content_type = 'text/css; charset=utf-8'
                return content_type
            return 'text/html; charset=utf-8'

        def get_content(current_file, files, path, repository_config, g_repo):
            """
            get the content if the page
            :param current_file: the current file
            :param files: the list of file of the current directory
            :param path: the accessed path
            :param repository_config: the repository configuration
            :param g_repo: the Github repository
            :return: the content of the page
            """
            cache_path = os.path.join(self.config_dir, repository_config['id'], "cache")
            file_path = path
            if current_file is not None:
                if current_file.type == 'dir':
                    file_path = os.path.join(current_file.path, "index.html")
                else:
                    file_path = current_file.path
            cached_file_path = os.path.join(cache_path, file_path)
            if os.path.exists(cached_file_path):
                return send_from_directory(os.path.dirname(cached_file_path), os.path.basename(cached_file_path),
                                           mimetype=get_type_content(path, path, repository_config, g_repo, False).replace("; charset=utf-8", ""))
            content = ''
            if current_file.type != 'dir' and is_website(path, repository_config, g_repo):
                if current_file.size > 1000000:
                    blob = g_repo.get_git_blob(current_file.sha)
                    if blob.encoding == 'base64':
                        content = base64.b64decode(blob.content).decode('utf-8')
                    else:
                        content = blob.content.decode('utf-8')
                else:
                    content = current_file.decoded_content.decode('utf-8')
                if ".html" in current_file.name \
                        or ".txt" in current_file.name \
                        or ".log" in current_file.name \
                        or ".java" in current_file.name \
                        or ".py" in current_file.name \
                        or ".xml" in current_file.name \
                        or ".json" in current_file.name \
                        or ".js" in current_file.name:
                    content = remove_terms(content, repository_config)
                if ".md" in current_file.name:
                    content = remove_terms(self.github.render_markdown(content), repository_config)
            else:
                tree = files 
                if type(tree) != list:
                    tree = files.tree
                content = render_template('repo.html',
                                       repository=repository_config,
                                       current_repository=repository_config['id'],
                                       current_file=current_file,
                                       files=tree,
                                       path_directory=path if type(
                                           current_file) is not github.ContentFile.ContentFile or current_file.type == 'dir' else os.path.dirname(
                                           current_file.path),
                                       path=path.split("/") if path != '' else [])
            content_cache_path = cached_file_path
            if not os.path.exists(os.path.dirname(content_cache_path)):
                os.makedirs(os.path.dirname(content_cache_path))
            with open(content_cache_path, 'w') as f:
                if type(content) == str:
                    f.write(content)
                else:
                    f.write(content.encode('utf8'))
            return content

        def is_website(path, repository_config, g_repo):
            """
            Check if the current request is a request to a GitHub pages
            :param path: the current path
            :param repository_config: the repository configuration
            :param g_repo: the Github repository
            :return: True if the current path is a website
            """
            return path[:4] == "docs"

        def is_default_file(f):
            default_name = ["readme", "index"]
            for name in default_name:
                try:
                    if type(f) is github.ContentFile.ContentFile:
                        f.name.lower().index(name)
                    elif type(f) is github.GitTreeElement.GitTreeElement:
                        f.path.lower().index(name)
                    return True
                except ValueError:
                    continue
            return False

        def get_current_folder_files(path, current_file, repository_config, g_repo, g_commit):
            """
            get the list of files of the current repository
            :param path: the path to the current file
            :param current_file: the current file
            :param repository_config: the repository configuration
            :param g_repo: the GitHub repository
            :return: the list of file of the current repository
            """
            files = []
            if current_file is None:
                return files, current_file
            if type(current_file) is not github.ContentFile.ContentFile:
                files = g_repo.get_git_tree(g_commit.sha)
                for f in current_file:
                    if is_default_file(f):
                        current_file = f
                        break
                if type(current_file) is not github.ContentFile.ContentFile:
                    current_file = current_file[0]
            elif current_file.type == 'file':
                if os.path.dirname(path) == '':
                    files = g_repo.get_git_tree(g_commit.sha)
                else:
                    f, folder = get_element_from_path(g_repo, g_commit, os.path.dirname(path))
                    if f is None:
                        files = folder
                    else:
                        files = g_repo.get_git_tree(f.sha)
            else:
                files = g_repo.get_git_tree(current_file.sha)
                for f in files.tree:
                    if is_default_file(f):
                        current_file, folder = get_element_from_path(g_repo, g_commit, os.path.join(path, f.path))
                        break
                if len(files.tree) == 1 and type(files.tree[0]) is github.ContentFile.ContentFile:
                    current_file, folder = get_element_from_path(g_repo, g_commit, os.path.join(path, files.tree[0].path))
            return files, current_file

        @application.route('/repository/<id>', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/<path:path>', methods=['GET'])
        @application.route('/r/<id>', methods=['GET'], defaults={'path': ''})
        @application.route('/r/<id>/', methods=['GET'], defaults={'path': ''})
        @application.route('/r/<id>/<path:path>', methods=['GET'])
        def repository(id, path):
            repo_path = self.config_dir + "/" + str(id)
            config_path = repo_path + "/config.json"
            if not os.path.exists(config_path):
                return render_template('404.html'), 404
            with open(config_path, 'r') as f:
                repository_configuration = json.load(f)
                (username, repo, branch) = clean_github_repository(repository_configuration['repository'])
                g_repo = self.github.get_repo("%s/%s" % (username, repo))
                g_commit = None
                try:
                    g_commit = g_repo.get_commit(branch)
                except:
                    return render_template('empty.html'), 404

                if not is_up_to_date(repository_configuration, g_commit):
                    if os.path.exists(os.path.join(repo_path, "cache")):
                        shutil.rmtree(os.path.join(repo_path, "cache"))
                    commit_date = datetime.strptime(g_commit.last_modified, "%a, %d %b %Y %H:%M:%S %Z")
                    repository_configuration["pushed_at"] = commit_date.strftime("%s")
                    with open(config_path, 'w') as fa:
                        json.dump(repository_configuration, fa)

                cache_path = os.path.join(self.config_dir, id, "cache")
                if os.path.isfile(os.path.join(cache_path, path)):
                    return send_from_directory(os.path.dirname(os.path.join(cache_path, path)),
                                               os.path.basename(os.path.join(cache_path, path)),
                                               mimetype=get_type_content(path, path, repository_configuration, g_repo, is_website(path, repository_configuration, g_repo)).replace("; charset=utf-8", ""))
                elif os.path.exists(os.path.join(cache_path, path, "index.html")):
                    return send_from_directory(os.path.join(cache_path, path), "index.html", mimetype='text/html')
                elif os.path.exists(os.path.join(cache_path, path, "README.md")):
                    return send_from_directory(os.path.join(cache_path, path), "README.md", mimetype='text/html')

                clean_path = path
                if len(clean_path) > 0 and clean_path[-1] == '/':
                    clean_path = clean_path[0:-1]
 
                current_file, files = get_element_from_path(g_repo, g_commit, clean_path)
                if current_file is None:
                    return render_template('404.html'), 404
                if type(current_file) == github.ContentFile.ContentFile and current_file.type == 'dir' and len(path) > 0 and path[-1] != '/':
                    return redirect(url_for('repository', id=id, path=path + '/'))

                files, current_file = get_current_folder_files(clean_path, current_file, repository_configuration, g_repo, g_commit)

                content = get_content(current_file, files, clean_path, repository_configuration, g_repo)
                content_type = get_type_content(current_file.name, clean_path, repository_configuration, g_repo, False)
                return content, {'Content-Type': content_type}

        @application.route('/', methods=['GET'])
        def index():
            id = request.args.get('id', None)
            repo_name = clean_github_repository(request.args.get('githubRepository', None))
            repo = None
            if id is not None:
                config_path = self.config_dir + "/" + id + "/config.json"
                if os.path.exists(config_path):
                    with open(config_path) as f:
                        data = json.load(f)
                        if repo_name == clean_github_repository(data['repository']):
                            repo = data

            return render_template('index.html', repo=repo)

        @application.route('/', methods=['POST'])
        def add_repository():
            id = request.args.get('id', str(uuid.uuid4()))
            repo = request.form['githubRepository']
            terms = request.form['terms']

            config_path = self.config_dir + "/" + str(id)
            if not os.path.exists(config_path):
                os.mkdir(config_path)
            with open(config_path + "/config.json", 'w') as outfile:
                json.dump({
                    "id": id,
                    "repository": repo,
                    "terms": terms.splitlines()
                }, outfile)
            return redirect(url_for('repository', id=id))

        return application

    def run(self, **keywords):
        self.application.run(host="127.0.0.1", port=self.port, **keywords)


def initParser():
    parser = argparse.ArgumentParser(description='Start Anonymous Github')
    parser.add_argument('-token', required=True, help='GitHub token')
    parser.add_argument('-host', help='The hostname', default="127.0.0.1")
    parser.add_argument('-port', help='The port of the application', default=5000)
    parser.add_argument('-config_dir', help='The repository that will contains the configuration files',
                        default='./repositories')
    return parser.parse_args()


if __name__ == "__main__":
    args = initParser()
    Anonymous_Github(github_token=args.token, host=args.host, port=args.port, config_dir=args.config_dir).run()

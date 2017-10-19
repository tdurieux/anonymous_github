import argparse
import uuid
import json
import socket
import os
import urllib
import re
import shutil
import base64

# non standards, in requirements.txt
from flask import Flask, request, Markup, render_template, redirect, url_for, send_from_directory
import requests
import github


def clean_github_repository(repo):
    if repo is None:
        return None
    repo = repo.replace("http://github.com/", "") \
        .replace("https://github.com/", "")
    if repo[-1] == '/':
        repo = repo[:-1]
    return repo


class Anonymous_Github:
    def __init__(self, github_token, host="127.0.0.1", port=5000,
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
        application.log = {}
        application.killurl = str(uuid.uuid4())
        application.jinja_env.add_extension('jinja2.ext.do')

        def removeTerms(content, repository):
            repo = repository['repository']
            if repo[-1] == '/':
                repo = repo[0:-1]
            content = re.compile(repo + "/blob/master", re.IGNORECASE).sub(
                self.public_url + "/repository/" + repository["id"], content)
            content = re.compile(repo, re.IGNORECASE).sub(self.public_url + "/repository/" + repository["id"], content)
            for term in repository['terms']:
                content = re.compile(term, re.IGNORECASE).sub("XXX", content)
            return content

        @application.template_filter('file_render', )
        def file_render(file, repository):
            if type(file) == github.Commit.Commit:
                return Markup(removeTerms(render_template('patch.html', patch=file), repository))
            if file.type == 'dir':
                return ""
            if file.size > 1000000:
                return Markup("The file %s is too big please download it: <a href='%s'>Download %s</a>" % (
                file.name, file.url, file.name))
            if ".md" in file.name:
                return Markup("<div class='markdown-body'>%s</div>" % removeTerms(
                    self.github.render_markdown(file.decoded_content), repository))
            if ".jpg" in file.name or ".png" in file.name or ".png" in file.name or ".gif" in file.name:
                return Markup("<img src='%s' alt='%s'>" % (file.url, file.name))
            if ".html" in file.name:
                return removeTerms(Markup(file.decoded_content), repository)
            if ".txt" in file.name or ".log" in file.name or ".xml" in file.name or ".json" in file.name or ".java" in file.name or ".py" in file.name:
                return removeTerms(Markup("<pre>" + file.decoded_content + "</pre>"), repository)
            return Markup("<a href='%s'>Download %s</a>" % (file.url, file.name))

        @application.route('/' + application.killurl, methods=['POST'])
        def seriouslykill():
            func = request.environ.get('werkzeug.server.shutdown')
            func()
            return "Shutting down..."

        def get_current_element(g_repo, path):
            if path == '':
                return g_repo.get_contents('/')
            current_element = os.path.basename(path)
            folder_content = g_repo.get_contents(urllib.quote(os.path.dirname(path)))
            for file in folder_content:
                if file.name == current_element:
                    return file
            return None

        @application.route('/repository/<id>/commit/<sha>', methods=['GET'])
        def commit(id, sha):
            config_path = self.config_dir + "/" + str(id) + "/config.json"
            if not os.path.exists(config_path):
                return render_template('404.html'), 404
            with open(config_path) as f:
                data = json.load(f)
                repo = clean_github_repository(data['repository'])
                g_repo = self.github.get_repo(repo)
                commit = g_repo.get_commit(sha)
                return render_template('repo.html',
                                   repository=data,
                                   current_repository=id,
                                   current_file=commit,
                                   files=[],
                                   path=[])

        def is_up_to_date(repository_config, g_repo):
            return 'pushed_at' in repository_config and g_repo.pushed_at.strftime("%s") == repository_config["pushed_at"]

        def get_type_content(file_name, path, data, g_repo):
            if is_website(path, data, g_repo):
                content_type = 'text/plain; charset=utf-8'
                if ".html" in file_name:
                    content_type = 'text/html; charset=utf-8'
                if ".md" in file_name:
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
                        or ".java" in file_name \
                        or ".py" in file_name \
                        or ".xml" in file_name \
                        or ".json" in file_name \
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
            cache_path = os.path.join(self.config_dir, repository_config['id'], "cache")
            file_path = path
            if current_file is not None:
                if current_file.type == 'dir':
                    file_path = os.path.join(current_file.path, "index.html")
                else:
                    file_path = current_file.path
            cached_file_path = os.path.join(cache_path, file_path)
            if os.path.exists(cached_file_path):
                return send_from_directory(os.path.dirname(cached_file_path), os.path.basename(cached_file_path))
            content = ''
            if is_website(path, repository_config, g_repo):
                if current_file.size > 1000000:
                    blob = g_repo.get_git_blob(current_file.sha)
                    if blob.encoding == 'base64':
                        content = base64.b64decode(blob.content)
                    else:
                        content = blob.content
                else:
                    content = current_file.decoded_content
                if ".html" in current_file.name \
                        or ".txt" in current_file.name \
                        or ".log" in current_file.name \
                        or ".java" in current_file.name \
                        or ".py" in current_file.name \
                        or ".xml" in current_file.name \
                        or ".json" in current_file.name \
                        or ".js" in current_file.name:
                    content = removeTerms(content, repository_config)
                if ".md" in current_file.name:
                    content = removeTerms(self.github.render_markdown(content), repository_config)
            else:
                content = render_template('repo.html',
                                       repository=repository_config,
                                       current_repository=repository_config['id'],
                                       current_file=current_file,
                                       files=files.tree,
                                       path_directory=path if type(
                                           current_file) is not github.ContentFile.ContentFile or current_file.type == 'dir' else os.path.dirname(
                                           path),
                                       path=path.split("/") if path != '' else [])
            content_cache_path = cached_file_path
            if not os.path.exists(os.path.dirname(content_cache_path)):
                os.makedirs(os.path.dirname(content_cache_path))
            with open(content_cache_path, 'w') as f:
                f.write(content)
            return content

        def is_website(path, repository_config, g_repo):
            return path[:4] == "docs"

        def get_current_folder_files(path, current_file, repository_config, g_repo):
            files = []
            if type(current_file) is not github.ContentFile.ContentFile:
                files = g_repo.get_git_tree("master")
                for f in current_file:
                    if f.name.lower() == "readme.md" or f.name.lower() == "index.html":
                        current_file = f
                        break
            elif current_file.type == 'file':
                if os.path.dirname(path) == '':
                    files = g_repo.get_git_tree("master")
                else:
                    files = g_repo.get_git_tree(get_current_element(g_repo, os.path.dirname(path)).sha)
            else:
                files = g_repo.get_git_tree(current_file.sha)
                for f in files.tree:
                    if f.path.lower() == "readme.md" or f.path.lower() == "index.html":
                        current_file = get_current_element(g_repo, os.path.join(path, f.path))
                        break
            return files, current_file

        @application.route('/repository/<id>', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/<path:path>', methods=['GET'])
        def repository(id, path):
            repo_path = self.config_dir + "/" + str(id)
            config_path = repo_path + "/config.json"
            if not os.path.exists(config_path):
                return render_template('404.html'), 404
            with open(config_path, 'rw') as f:
                data = json.load(f)
                repo = clean_github_repository(data['repository'])
                g_repo = self.github.get_repo(repo)

                if not is_up_to_date(data, g_repo):
                    if os.path.exists(os.path.join(repo_path, "cache")):
                        shutil.rmtree(os.path.join(repo_path, "cache"))
                    data["pushed_at"] = g_repo.pushed_at.strftime("%s")
                    with open(config_path, 'w') as fa:
                        json.dump(data, fa)

                cache_path = os.path.join(self.config_dir, id, "cache")
                if os.path.isfile(os.path.join(cache_path, path)):
                    return send_from_directory(os.path.dirname(os.path.join(cache_path, path)),
                                               os.path.basename(os.path.join(cache_path, path))),\
                           {'Content-Type': get_type_content(path, path, data, g_repo)}
                elif os.path.exists(os.path.join(cache_path, path, "index.html")):
                    return send_from_directory(os.path.join(cache_path, path), "index.html")
                elif os.path.exists(os.path.join(cache_path, path, "README.md")):
                    return send_from_directory(os.path.join(cache_path, path), "README.md")

                clean_path = path
                if len(clean_path) > 0 and clean_path[-1] == '/':
                    clean_path = clean_path[0:-1]

                current_file = get_current_element(g_repo, clean_path)
                if type(current_file) == github.ContentFile.ContentFile and current_file.type == 'dir' and len(path) > 0 and path[-1] != '/':
                    return redirect(url_for('repository', id=id, path=path + '/'))

                files, current_file = get_current_folder_files(clean_path, current_file, data, g_repo)

                content = get_content(current_file, files, clean_path, data, g_repo)
                content_type = get_type_content(current_file.name, clean_path, data, g_repo)

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
                        repo_data = clean_github_repository(data['repository'])
                        if repo_name == repo_data:
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
    parser.add_argument('-token', required=True, help='GitHuh token')
    parser.add_argument('-host', help='The hostname', default="127.0.0.1")
    parser.add_argument('-port', help='The port of the application', default=5000)
    parser.add_argument('-config_dir', help='The repository that will contains the configuration files',
                        default='./repositories')
    return parser.parse_args()


if __name__ == "__main__":
    args = initParser()
    Anonymous_Github(github_token=args.token, host=args.host, port=args.port, config_dir=args.config_dir).run()

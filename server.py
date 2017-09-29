import argparse
import uuid
import json
import socket
import os
import urllib

# non standards, in requirements.txt
from flask import Flask, request, Markup, render_template, redirect, url_for
import requests
import github




class Anonymous_Github:
    def __init__(self, github_token="0e8f5af6801d89e533f5c045920e928b4535d41e", host="127.0.0.1", port=5000,
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
            self.public_url = "http://" + self.host + ":" + str(self.port)



    def create_flask_application(self):
        application = Flask(__name__)
        application.log = {}
        application.killurl = str(uuid.uuid4())

        @application.template_filter('file_render', )
        def file_render(file, terms):
            def removeTerms(content, terms):
                for term in terms:
                    content = content.replace(term, "XXX")
                return content
            if ".md" in file.name:
                return Markup("<div class='markdown-body'>%s</div>" % removeTerms(self.github.render_markdown(file.decoded_content), terms))
            if ".jpg" in file.name or ".png" in file.name or ".png" in file.name or ".gif" in file.name:
                return Markup("<img src='%s' alt='%s'>" % (file.url, file.name))
            if ".html" in file.name:
                return removeTerms(Markup(file.decoded_content), terms)
            if ".txt" in file.name or ".log" in file.name or ".xml" in file.name or ".java" in file.name or ".py" in file.name:
                return removeTerms(Markup("<pre>" + file.decoded_content + "</pre>"), terms)
            return Markup("<a href='%s'>Download %s</a>" % (file.url, file.name))

        @application.route('/' + application.killurl, methods=['POST'])
        def seriouslykill():
            func = request.environ.get('werkzeug.server.shutdown')
            func()
            return "Shutting down..."

        @application.route('/repository/<id>', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/', methods=['GET'], defaults={'path': ''})
        @application.route('/repository/<id>/<path:path>', methods=['GET'])
        def repository(id, path):
            config_path = self.config_dir + "/" + str(id) + "/config.json"
            if not os.path.exists(config_path):
                return render_template('404.html'), 404
            with open(config_path) as f:
                data = json.load(f)
                repo = data['repository']\
                    .replace("http://github.com/", "")\
                    .replace("https://github.com/", "")
                if repo[-1] == '/':
                    repo = repo[:-1]
                g_repo = self.github.get_repo(repo)
                current_folder = g_repo.get_contents(urllib.quote(path))
                current_file = None
                if type(current_folder) is github.ContentFile.ContentFile:
                    current_file = current_folder
                    current_folder = g_repo.get_contents(urllib.quote(os.path.dirname(path)))
                else:
                    for f in current_folder:
                        if f.name.lower() == "readme.md" or f.name.lower() == "index.html":
                            current_file = f
                            break

                return render_template('repo.html',
                                       name=data['name'],
                                       terms=data["terms"],
                                       current_repository=id,
                                       current_file=current_file,
                                       current_folder=current_folder,
                                       path=path.split("/") if path != '' else [])

        @application.route('/', methods=['GET'])
        def index():
            return render_template('index.html')

        @application.route('/', methods=['POST'])
        def add_repository():
            id = str(uuid.uuid4())
            repo = request.form['githubRepository']
            terms = request.form['terms'],
            repo_name = request.form['name']

            config_path = self.config_dir + "/" + str(id)
            os.mkdir(config_path)
            with open(config_path + "/config.json", 'w') as outfile:
                json.dump({
                    "id": id,
                    "name": repo_name,
                    "repository": repo,
                    "terms": terms.split()
                }, outfile)
            return redirect(url_for('repository', id=id))

        return application

    def run(self, **keywords):
        self.application.run(host=self.host, port=self.port, **keywords)


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

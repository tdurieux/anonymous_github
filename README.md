Anonymous Github
================

Anonymous Github is a system to anonymize Github repositories before referring to them in a double-blind paper submission.
To start using Anonymous Github right now: **[http://anonymous.4open.science/](http://anonymous.4open.science/)**

Indeed, in a double-blind review process, the open-science data or code that is in the online appendix must be anonymized, similarly to paper anonymization. The authors must

* anonymize URLs: the name of the institution/department/group/authors should not appear in the  URLs of the open-science appendix
* anonymize the appendix content itself

Anonymizing an open-science appendix needs some work, but fortunately, this can be automated, this is what Anonymous Github is about.

Anonymous Github anonymizes:
* the Github owner / organization / repository name
* the content of the repository
  * file contents (all extensions, md/txt/java/etc)
  * file and directory names

Question / Feedback / Bug report: please open an issue in this repository.

Using Anonymous Github
-----------------------


## How to create a new anonymized repository

To use it, open the main page (e.g., [http://anonymous.4open.science/](http://anonymous.4open.science/)), login with GitHub, and click on "Anonymize".
Simply fill 1. the Github repo URL and 2. the id of the anonymized repository, 3. the terms to anonymize (which can be updated afterwards). 
The anonymization of the content is done by replacing all occurrences of words in a list by "XXX". 
The word list is provided by the authors, and typically contains the institution name, author names, logins, etc...
The README is anonymized as well as all files of the repository. Even filenames are anonymized. 

In a paper under double-blind review, instead of putting a link to Github, one puts a link to the Anonymous Github instance (e.g. 
<http://anonymous.4open.science/r/840c8c57-3c32-451e-bf12-0e20be300389/> which is an anonymous version of this repo).

To start using Anonymous Github right now, a public instance of anonymous_github is hosted at 4open.science:

**[http://anonymous.4open.science/](http://anonymous.4open.science/)**

## What is the scope of anonymization?

In double-blind peer-review, the boundary of anonymization is the paper plus its online appendix, and only this, it's not the whole world. Googling any part of the paper or the online appendix can be considered as deliberate attempt to break anonymity ([explanation](http://www.monperrus.net/martin/open-science-double-blind))


How it works?
--------------

Anonymous Github either download the complete repository and anonymize the content of the file or proxy the request to GitHub. In both case, the original and anonymized versions of the file are cached on the server. 

Installing Anonymous Github
----------------------------
1. Clone the repository
```bash
git clone https://github.com/tdurieux/anonymous_github/
cd anonymous_github
npm i
```

2. Configure the Github tocken

Create a file `.env` that contains

```env
GITHUB_TOKEN=<GITHUB_TOKEN>
CLIENT_ID=<CLIENT_ID>
CLIENT_SECRET=<CLIENT_SECRET>
PORT=5000
DB_USERNAME=
DB_PASSWORD=
AUTH_CALLBACK=http://localhost:5000/github/auth,
```

`GITHUB_TOKEN` can be generate here: https://github.com/settings/tokens/new with `repo` scope.
`CLIENT_ID` and `CLIENT_SECRET` are the tokens are generated when you create a new GitHub app https://github.com/settings/applications/new.
The callback of the GitHub app needs to be defined as `https://<host>/github/auth` (the same as defined in AUTH_CALLBACK).

3. Run Anonymous Github
```bash
docker-compose up -d
```

4. Go to Anonymous Github

By default, Anonymous Github uses the port 5000. It can be changed in `docker-compose.yml`.


Related tools
--------------
[gitmask](https://www.gitmask.com/) is a tool to anonymously contribute to a Github repository.

[blind-reviews](https://github.com/zombie/blind-reviews/) is a browser add-on that enables a person reviewing a GitHub pull request to hide identifying information about the person submitting it.

See also
--------

* [Open-science and Double-blind Peer-Review](http://www.monperrus.net/martin/open-science-double-blind)

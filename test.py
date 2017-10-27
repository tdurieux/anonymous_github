import ast
import unittest
import tempfile
import uuid
import shutil

from server import Anonymous_Github


class FlaskrTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_db_location = tempfile.mkdtemp()
        self.app = Anonymous_Github(github_token="", config_dir=self.temp_db_location).application.test_client()

    def tearDown(self):
        shutil.rmtree(self.temp_db_location)

    def create_repository(self, url, terms):
        anonymous_id = uuid.uuid4()
        self.app.post("/?id=%s" % anonymous_id, data={
            'githubRepository': url,
            'terms': terms
        })
        return anonymous_id

    def test_source_code_compatible(self):
        try:
            ast.parse(open('server.py').read())
            assert True
        except SyntaxError:
            assert False

    def test_index(self):
        rv = self.app.get("/")
        assert b"<title>GitHub Anonymous</title>" in rv.data

    def test_create_repository(self):
        anonymous_id = self.create_repository("https://github.com/tdurieux/anonymous_github/", "github")
        rv = self.app.get("/repository/%s/" % anonymous_id)
        assert b"Anonymous XXX" in rv.data


if __name__ == '__main__':
    unittest.main()

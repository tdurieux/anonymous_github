const express = require("express");
const compression = require('compression');
const bodyParser = require("body-parser");

var app = express();
app.use(bodyParser.json());
app.use(compression())

app.use(express.static(__dirname + "/publics"));

app.get("/myrepo", (req, res) => {
    res.status(500).send("To implement!")
})

app.get("/repository/:id/commit/:sha", (req, res) => {
    res.status(500).send("To implement!")
})

app.route("api")
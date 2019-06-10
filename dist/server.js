"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const types_ti_1 = __importDefault(require("./types-ti"));
const ts_interface_checker_1 = require("ts-interface-checker");
const { Member } = ts_interface_checker_1.createCheckers(types_ti_1.default);
const rxcouch_1 = require("@mkeen/rxcouch");
const app = express_1.default();
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.json());
const couch = new rxcouch_1.CouchDB({
    dbName: 'terragon',
    host: 'couchdb-a.terragon.us',
    port: 443,
    ssl: true
}, rxcouch_1.AuthorizationBehavior.cookie, process.env.COUCH_USER, process.env.COUCH_PASS);
app.post('/user', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
        Member.check(req.body);
        const incoming = req.body;
        const doc = couch.doc(incoming)
            .subscribe((_a) => {
            res.end(JSON.stringify(_a));
        });
    }
    catch (e) {
        res.status(400);
        res.end(JSON.stringify({}));
    }
});
app.listen(3000, () => console.log('Dev mode on port 3000 online'));
//# sourceMappingURL=server.js.map
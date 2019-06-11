import express from 'express';

import { Member } from './types';

import typesTI from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member } = createCheckers(typesTI);

import { CouchDB, AuthorizationBehavior } from '@mkeen/rxcouch';

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const couch = new CouchDB({
  dbName: 'terragon',
  host: 'couchdb-a.terragon.us',
  port: 443,
  ssl: true
}, AuthorizationBehavior.cookie,
  process.env.COUCH_USER,
  process.env.COUCH_PASS,
);

app.post('/user', (req: any, res: any) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    Member.check(req.body);
    const incoming: Member = req.body;
    const doc = couch.doc(incoming)
      .subscribe((_a: any) => {
        res.end(JSON.stringify(_a));
      });

  } catch (e) {
    res.status(400);
    res.end(JSON.stringify({}));
  }

});

app.get('/', (req: any, res: any) => {
  res.end("hi");
})

app.listen(3000, () => console.log('Dev mode on port 3000 online'));


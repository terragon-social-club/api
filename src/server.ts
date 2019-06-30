import express from 'express';
import Stripe from "stripe";
import { of, Observable } from 'rxjs';
import { take } from 'rxjs/operators';

import { Member } from './types';

import typesTI from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member } = createCheckers(typesTI);

import { CouchDB, AuthorizationBehavior, CouchDBDocument } from '@mkeen/rxcouch';

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_KEY);

const couch = new CouchDB({
  dbName: 'users',
  host: 'localhost',
  port: 5984,
  ssl: false,
  trackChanges: false
}, AuthorizationBehavior.cookie,
  of({
    username: process.env.COUCH_USER,
    password: process.env.COUCH_PASS
  })
);

app.post('/user', (req: any, res: any) => {
  res.setHeader('Content-Type', 'application/json');
  Member.strictCheck(req.body);
  const incoming: Member = req.body;

  couch.find({
    selector: {
      phone: incoming.phone
    }
  }).subscribe((documents: CouchDBDocument[]) => {
    if (documents.length === 0) {
      couch.doc(incoming)
        .pipe(take(1))
        .subscribe((newDoc: CouchDBDocument) => {
          stripe.customers.create({
            email: newDoc.email,
            metadata: {
              userId: newDoc._id
            }
          }, function(err: any, customer: any) {
            let doc = newDoc;
            doc.stripe_id = customer.id;
            couch.doc(doc).subscribe((savedDoc: CouchDBDocument) => {
              res.end(JSON.stringify(['savedCustomer']))
            }).unsubscribe()
          });

          //res.end(JSON.stringify(newDoc));
        })
        ;
    } else {
      res.end(JSON.stringify({}));
    }

  })

});

app.listen(3000, '127.0.0.1');

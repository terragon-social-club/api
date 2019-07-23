import express from 'express';
import Stripe from "stripe";
import { of } from 'rxjs';
import { take } from 'rxjs/operators';

import { Member, Card } from './types';

import typesTI from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member, Card } = createCheckers(typesTI);

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
      "$or": [
        { "email": incoming.email },
        { "phone": incoming.phone }
      ]
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

          }, (err: any, customer: any) => {
            let doc = newDoc;
            doc.stripe_id = customer.id;
            couch.doc(doc).subscribe((savedDoc: CouchDBDocument) => {
              res.end(JSON.stringify(savedDoc._id))
            }).unsubscribe();

          });

        });

    } else {
      // Do something smart if user exists
      res.end(JSON.stringify(documents));
    }

  })

});

app.post('/user/:userId/card', (req: any, res: any) => {
  res.setHeader('Content-Type', 'application/json');
  Card.strictCheck(req.body);
  const incoming: Card = req.body;
  couch.find({
    selector: {
      "_id": req.params.userId
    }

  }).subscribe((documents: CouchDBDocument[]) => {
    let matchingMember: any = documents[0];
    if (!matchingMember['stripe_id']) {
      res.end(JSON.stringify({ error: 'no_commerce_account' }));
    } else {
      stripe.customers.retrieve(
        matchingMember['stripe_id'],
        (err: any, customer: any) => {
          console.log(err);

          if (customer.sources.length) {
            res.end(JSON.stringify({ error: 'card_already_added' }));
          } else {
            (<any>stripe)['paymentMethods'].create({
              type: 'card',
              card: {
                number: incoming.account_number,
                exp_month: incoming.expiration_month,
                exp_year: incoming.expiration_year
              }

            }, (err: any, paymentMethod: any) => {
              console.log(err);
              stripe.paymentIntents.create({
                currency: 'usd',
                confirm: true,
                amount: 2500,
                customer: customer.id,
                save_payment_method: true,
                payment_method_types: ['card'],
                //setup_future_usage: 'off_session',
                payment_method: paymentMethod.id
              }, (err: any, paymentIntent: any) => {
                console.log(err);
                res.end(JSON.stringify(paymentIntent));
              });

            });

          }

        }

      );
    }

  });

});

app.listen(3000, '127.0.0.1');

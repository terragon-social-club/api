import express from 'express';
import Stripe from "stripe";
import { of, Observable, Observer, zip } from 'rxjs';
import { take } from 'rxjs/operators';

import { Member, Card, ValidatorResult } from './types';

import typesTI from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member, Card } = createCheckers(typesTI);
import { parsePhoneNumber } from 'libphonenumber-js';

import { CouchDB, AuthorizationBehavior, CouchDBDocument } from '@mkeen/rxcouch';

const legit = require('legit');

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

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "http://localhost:4200"); // update to match the domain you will make the request from
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

const checkIfUserExists = (byValue: string, callback: (exists: boolean) => void, byField = 'username') => {
  let selector: any = {}
  selector[byField] = byValue;

  couch.find({
    selector
  }).pipe(take(1)).subscribe((documents: CouchDBDocument[]) => {
    callback(documents.length > 0);
  });

}

const validateUsername = (username: any) => {
  if (!(typeof username === 'string')) {
    return false;
  }

  const normalizedUsername = username.toLowerCase();

  if (normalizedUsername.includes('admin') || normalizedUsername.includes('terragon')) {
    return false;
  }

  const pattern = /^[\w0-9]+$/;
  if (!username.match(pattern)) {
    return false;
  }

  return true;
}

app.get('/user/exists/:userId', (req: any, res: any) => {
  res.setHeader('Content-Type', 'application/json');

  checkIfUserExists(req.params.userId, (exists) => {
    res.end(JSON.stringify({ exists }));
  });

});

app.post('/user', (req: any, res: any) => {
  res.setHeader('Content-Type', 'application/json');
  Member.strictCheck(req.body);
  const incoming: Member = req.body;

  const validators = [
    // Email
    Observable.create((observer: Observer<ValidatorResult>) => {
      legit(incoming.email)
        .then((result: any) => {
          if (result.isValid) {
            checkIfUserExists(incoming.email, (exists: boolean) => {
              if (exists) {
                observer.next({ error: true, detail: { field_name: 'email', message: 'A user with this email address already exists.' } });
              } else {
                observer.next({ error: false });
              }

            }, 'email');

          } else {
            observer.next({ error: true, detail: { field_name: 'email', message: 'Invalid Email Address' } });
          }

        })
        .catch(
          (_err: any) => {
            observer.next({ error: true, detail: { field_name: 'email', message: 'Invalid Email Address' } });
          }

        );

    }),

    // Name
    Observable.create((observer: Observer<ValidatorResult>) => {
      if (incoming.name.length) {
        observer.next({ error: false });
      } else {
        observer.next({ error: true, detail: { field_name: 'name', message: 'Name is Required' } });
      }

    }),

    // Username
    Observable.create((observer: Observer<ValidatorResult>) => {
      if (!validateUsername(incoming.username)) {
        observer.next({ error: true, detail: { field_name: 'username', message: 'Invalid Username' } });
      } else {
        checkIfUserExists(incoming.username, (exists: boolean) => {
          if (exists) {
            observer.next({ error: true, detail: { field_name: 'username', message: 'Username is taken.' } });
          } else {
            observer.next({ error: false });
          }

        });

      }

    }),

    // Phone Number
    Observable.create((observer: Observer<ValidatorResult>) => {
      if (!incoming.phone) {
        observer.next({ error: false });
      } else if (!incoming.phone.length) {
        observer.next({ error: false });
      } else {
        try {
          const phoneNumber = parsePhoneNumber(incoming.phone, 'US');
          if (phoneNumber.isValid()) {
            incoming.phone = phoneNumber.formatInternational();
            observer.next({ error: false });
          } else {
            observer.next({ error: true, detail: { field_name: 'phone', message: 'Invalid Phone Number' } });
          }

        } catch (e) {
          observer.next({ error: true, detail: { field_name: 'phone', message: 'Invalid Phone Number' } });
        }

      }

    }),

    // Password
    Observable.create((observer: Observer<ValidatorResult>) => {
      if (!incoming.password.length) {
        observer.next({ error: true, detail: { field_name: 'password', message: 'Passwords must be at least 8 characters long.' } });
      } else if (incoming.password.length < 8) {
        observer.next({ error: true, detail: { field_name: 'password', message: 'Passwords must be at least 8 characters long.' } });
      } else if (incoming.password !== incoming.password_confirm) {
        observer.next({ error: true, detail: { field_name: 'password', message: 'Passwords must match.' } });
      } else {
        observer.next({ error: false });
      }

    }),

  ];

  zip(...validators)
    .pipe(take(1))
    .subscribe((validators: ValidatorResult[]) => {
      const errors = validators.filter(error => error.error === true);
      if (errors.length) {
        res.end(JSON.stringify(errors));
      } else {
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

      }

    });

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
            (<any>stripe).paymentMethods.create({
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

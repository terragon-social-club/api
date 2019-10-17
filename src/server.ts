import express from 'express';

import Stripe from "stripe";
import { of, Observable, Observer, zip, interval, BehaviorSubject, Subject } from 'rxjs';
import { take, filter, tap, skip } from 'rxjs/operators';

import { Member, ValidatorResult, FoundingMemberPayment } from './types';

import typesTI, { } from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member, FoundingMemberPayment } = createCheckers(typesTI);
import { parsePhoneNumber } from 'libphonenumber-js';

import { CouchDB, AuthorizationBehavior, CouchDBDocument } from '@mkeen/rxcouch';
import { CouchDBCredentials, CouchDBSession } from '@mkeen/rxcouch/dist/types';

const legit = require('legit');

const stripe = new Stripe(process.env.STRIPE_KEY);

let couchDbUsers: CouchDB | null = null;
let couchDbUserProfiles: CouchDB | null = null;

const shouldConnect: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

let stayConnected: Observable<boolean> | null = null;

const credentials: Observable<CouchDBCredentials> = Observable.create((observer: Observer<CouchDBCredentials>) => {
  shouldConnect
    .pipe(
      skip(1),
      take(1)
    )
    .subscribe((_should) => {
      observer.next({
        username: process.env.COUCH_USER,
        password: process.env.COUCH_PASS
      })

    })

});

const cycle = () => {
  if (couchDbUsers === null && couchDbUserProfiles === null) {
    couchDbUsers = new CouchDB(
      {
        dbName: '_users',
        host: 'localhost',
        port: 5984,
        ssl: false,
        trackChanges: false
      },

      AuthorizationBehavior.cookie,
      credentials
    );

    couchDbUserProfiles = new CouchDB(
      {
        dbName: 'user_profiles',
        host: 'localhost',
        port: 5984,
        ssl: false,
        trackChanges: false
      },

      AuthorizationBehavior.cookie,
      credentials
    );

    shouldConnect.next(true);
  }

}

const openCouchDBConnections = () => {
  let mainLoop: Observable<any>;
  return Observable.create((mainObserver: Observer<boolean>) => {
    of(true)
      .pipe(
        tap(cycle),
        tap(() => {
          mainObserver.next(true);
        }),
        take(1)
      )
      .subscribe((_true) => {
        interval(3000)
          .pipe(
            tap(cycle),
            filter((_i: any) => {
              if (!mainLoop) {
                mainLoop = interval(30000);
                mainLoop.subscribe(() => mainObserver.next(true));
                return true;
              }

              if (couchDbUsers && couchDbUserProfiles.authenticated.value) {
                return false;
              } else {
                return false;
              }

            })
          ).subscribe(() => {
            console.log("should be blocked");
            mainObserver.next(true);
          });

      });

  });

}

let app: any;

const checkIfUserExists = (byValue: string, callback: (exists: boolean) => void, byField = 'name') => {
  let selector: any = {}
  selector[byField] = byValue;

  couchDbUsers.find({
    selector
  }).pipe(take(1)).subscribe((documents: CouchDBDocument[]) => {
    console.log("found", documents, couchDbUsers.authenticated.value)
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

  if (username.length < 3) {
    return false;
  }

  const pattern = /^[\w0-9]+$/;
  if (!username.match(pattern)) {
    return false;
  }

  return true;
}

const startExpress = () => {
  console.log("starting express");
  if (runningApp !== null) {
    console.log("quitting existing express");
    runningApp.close();
    runningApp = null;
  }

  app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(function(_req: any, res: any, next: any) {
    res.header("Access-Control-Allow-Origin", "http://localhost:4200"); // update to match the domain you will make the request from
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
  });

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
                  observer.next({ error: true, detail: { field: 'email', message: 'exists' } });
                } else {
                  observer.next({ error: false });
                }

              }, 'email');

            } else {
              observer.next({ error: true, detail: { field: 'email', message: 'invalid' } });
            }

          })
          .catch(
            (_err: any) => {
              observer.next({ error: true, detail: { field: 'email', message: 'invalid' } });
            }

          );

      }),

      // Person Name
      Observable.create((observer: Observer<ValidatorResult>) => {
        if (incoming.person_name.length) {
          observer.next({ error: false });
        } else {
          observer.next({ error: true, detail: { field: 'person_name', message: 'required' } });
        }

      }),

      // Name (username)
      Observable.create((observer: Observer<ValidatorResult>) => {
        if (!validateUsername(incoming.name)) {
          observer.next({ error: true, detail: { field: 'name', message: 'invalid' } });
        } else {
          checkIfUserExists(incoming.name, (exists: boolean) => {
            if (exists) {
              observer.next({ error: true, detail: { field: 'name', message: 'exists' } });
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
              observer.next({ error: true, detail: { field: 'phone', message: 'invalid' } });
            }

          } catch (e) {
            observer.next({ error: true, detail: { field: 'phone', message: 'invalid' } });
          }

        }

      }),

      // Password
      Observable.create((observer: Observer<ValidatorResult>) => {
        if (!incoming.password.length) {
          observer.next({ error: true, detail: { field: 'password', message: 'required' } });
        } else if (incoming.password.length < 8) {
          observer.next({ error: true, detail: { field: 'password', message: 'short' } });
        } else if (incoming.password !== incoming.password_confirm) {
          observer.next({ error: true, detail: { field: 'password', message: 'mismatch' } });
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
          res.end(JSON.stringify({ errors }));
        } else {
          delete incoming['password_confirm'];
          const newUserDocument = Object.assign(incoming, {
            _id: `org.couchdb.user:${incoming.name}`,
            roles: ['pending_member', 'member'],
            type: 'user',
            name: incoming.name
          });

          couchDbUsers.doc(newUserDocument)
            .pipe(take(1))
            .subscribe((newUserDoc: CouchDBDocument) => {
              stripe.customers.create({
                email: newUserDoc.email,
                metadata: {
                  userId: newUserDoc._id
                }

              }, (_err: any, customer: any) => {
                let doc = newUserDoc;
                doc.stripe_id = customer.id;
                couchDbUsers.doc(doc)
                  .pipe(take(1))
                  .subscribe((_savedDoc: CouchDBDocument) => {
                    console.log("saved initial", _savedDoc);

                    const credentials: Subject<CouchDBCredentials> = new Subject();

                    const credentialsObservable = Observable.create((observer: Observer<CouchDBCredentials>) => {
                      credentials.pipe(take(1)).subscribe(creds => observer.next(creds));
                    });

                    const tempCouchDbSession = new CouchDB(
                      {
                        dbName: 'user_profiles',
                        host: 'localhost',
                        port: 5984,
                        ssl: false,
                        trackChanges: false
                      },

                      AuthorizationBehavior.cookie,
                      credentialsObservable
                    );

                    tempCouchDbSession.authenticated
                      .pipe(
                        filter(authenticated => !!authenticated)
                      ).subscribe((_authenticated) => {
                        console.log("got auth", _authenticated);
                        tempCouchDbSession
                          .cookie
                          .pipe(
                            filter(cookie => cookie !== null),
                            take(1)
                          )
                          .subscribe((cookie) => {
                            console.log(cookie, "sending final req");
                            res.set('Set-Cookie', cookie);
                            res.end(JSON.stringify({}));
                          })

                      })

                  });

              });

            });

        }

      });

  });

  app.post('/user/:userId/payment', (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    FoundingMemberPayment.strictCheck(req.body);
    console.log(req.params.userId);
    const incoming: FoundingMemberPayment = req.body;
    couchDbUsers.find({
      selector: {
        "_id": req.params.userId
      }

    }).subscribe((documents: CouchDBDocument[]) => {
      console.log(documents);
      let matchingMember: any = documents[0];
      if (matchingMember['stripe_id'] === undefined) {
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
                  number: incoming.cc_number,
                  exp_month: incoming.cc_exp_month,
                  exp_year: incoming.cc_exp_year
                }

              }, (err: any, paymentMethod: any) => {
                if (!err) {
                  stripe.paymentIntents.create({
                    currency: 'usd',
                    confirm: true,
                    amount: incoming.contribution * 1000, // send to api in cents (1000 = 1 USD)
                    customer: customer.id,
                    save_payment_method: true,
                    payment_method_types: ['card'],
                    //setup_future_usage: 'off_session',
                    payment_method: paymentMethod.id
                  }, (err: any, _paymentIntent: any) => {
                    if (!err) {

                    } else {
                      res.end(JSON.stringify(err));
                    }

                  });

                }

              });

            }

          }

        );
      }

    });

  });

}

let runningApp: any = null;

openCouchDBConnections().subscribe((_a: any) => {
  // ensure only one instance of this occuring at a time by doing this:
  if (stayConnected === null) {
    stayConnected = Observable.create((observer: Observer<boolean>) => {
      zip(couchDbUsers.getSession(),
        couchDbUserProfiles.getSession())
        .pipe(take(1))
        .subscribe(
          (_sessions: CouchDBSession[]) => {
            console.log(_sessions);
            if (runningApp === null) {
              startExpress();
              console.log("starting http server");
              runningApp = app.listen(3000, '127.0.0.1', () => {
                observer.next(true);
              });

            } else {
              observer.next(true);
            }

          },

          (_err: any) => {
            console.log("could not connect to couchdb");
            if (runningApp !== null) {
              console.log("stopping http server");
              runningApp.close();
              runningApp = null;
            }

            observer.next(true);
          }

        );

    });

    stayConnected.pipe(take(1)).subscribe((_stay: any) => {
      stayConnected = null;
    });

  }

});

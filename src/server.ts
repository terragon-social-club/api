import express from 'express';

import Stripe from "stripe";
import { of, Observable, Observer, zip, interval, BehaviorSubject, Subject, pipe } from 'rxjs';
import { take, filter, tap, skip } from 'rxjs/operators';

import { Member, ValidatorResult, FoundingMemberPayment, Invite } from './types';

import typesTI, { } from "./types-ti";
import { createCheckers } from "ts-interface-checker";
const { Member, FoundingMemberPayment, Invite } = createCheckers(typesTI);
import { parsePhoneNumber } from 'libphonenumber-js';

import { CouchDB, AuthorizationBehavior, CouchDBDocument, CouchSession } from '@mkeen/rxcouch';
import { CouchDBCredentials, CouchDBSession } from '@mkeen/rxcouch/dist/types';

const legit = require('legit');

let couchDbUsers: CouchDB | null = null;
let couchDbUserProfiles: CouchDB | null = null;
let couchDbInviteCodes: CouchDB | null = null;
let terragonSysInfo: CouchDB | null = null;

const shouldConnect: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

const { COUCH_HOST, COUCH_PASS, COUCH_USER, COUCH_PORT, ORIGIN, API_BIND_IP, STRIPE_KEY } = process.env;

const stripe = new Stripe(STRIPE_KEY);

const credentials: Observable<CouchDBCredentials> = of({
  username: COUCH_USER,
  password: COUCH_PASS
});

const couchSession: CouchSession = new CouchSession(
  AuthorizationBehavior.cookie,
  `${COUCH_PORT === '443' ? 'https://' : 'http://'}${COUCH_HOST}:${COUCH_PORT}/_session`,
  credentials
);

const cycle = () => {
  if (couchDbUsers === null && couchDbUserProfiles === null) {
    couchDbUsers = new CouchDB(
      {
        dbName: '_users',
        host: COUCH_HOST,
        port: parseInt(COUCH_PORT),
        ssl: COUCH_PORT === '443',
        trackChanges: false
      },

      couchSession
    );

    terragonSysInfo = new CouchDB(
      {
        dbName: 'terragon_sysinfo',
        host: COUCH_HOST,
        port: parseInt(COUCH_PORT),
        ssl: COUCH_PORT === '443',
        trackChanges: false
      },

      couchSession
    );

    couchDbUserProfiles = new CouchDB(
      {
        dbName: 'user_profiles',
        host: COUCH_HOST,
        port: parseInt(COUCH_PORT),
        ssl: COUCH_PORT === '443',
        trackChanges: false
      },

      couchSession
    );

    couchDbInviteCodes = new CouchDB(
      {
        dbName: 'invite_codes',
        host: COUCH_HOST,
        port: parseInt(COUCH_PORT),
        ssl: COUCH_PORT === '443',
        trackChanges: false
      },

      couchSession
    );

    shouldConnect.next(true);
  }

}

let app: any;

const checkIfUserExists = (byValue: string, callback: (exists: boolean) => void, byField = 'name') => {
  let selector: any = {}
  selector[byField] = byValue;

  couchDbUsers.find({
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
    res.header("Access-Control-Allow-Origin", ORIGIN); // update to match the domain you will make the request from
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

          console.log("creating new user document");
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
                    const credentials: Subject<CouchDBCredentials> = new Subject();

                    const credentialsObservable = Observable.create((observer: Observer<CouchDBCredentials>) => {
                      credentials.pipe(take(1)).subscribe(creds => observer.next(creds));
                    });

                    couchDbUserProfiles.doc({
                      _id: incoming.name,
                      roles: newUserDocument.roles
                    }).pipe(take(1)).subscribe((profile) => {
                      console.log("profile created!", profile);
                      const tempCouchDbSession = new CouchDB(
                        {
                          dbName: 'user_profiles',
                          host: COUCH_HOST,
                          port: parseInt(COUCH_PORT),
                          ssl: false,
                          trackChanges: false
                        },

                        couchSession
                      );

                      tempCouchDbSession.couchSession.get()
                        .pipe(take(1))
                        .subscribe((couchDbSession) => {
                          tempCouchDbSession.couchSession
                          .cookie
                          .pipe(
                            filter(cookie => cookie !== null),
                            take(1)
                          ).subscribe((cookie: string) => {
                            res.set('Set-Cookie', cookie);
                            res.end(JSON.stringify([couchDbSession.userCtx, profile]));
                          });

                      });

                      credentials.next({
                        username: incoming.name,
                        password: incoming.password
                      });

                    });

                  });

              });

            });

        }

      });

  });

  app.post('/user/:userId/invite', (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    Invite.strictCheck(req.body);
    const incoming: Invite = req.body;
    couchDbUsers.doc(req.params.userId).subscribe((document: CouchDBDocument) => {
      let matchingMember: any = document;
      if (!matchingMember.roles.includes('pending_member')) {
        res.end(JSON.stringify({error: 'ineligable'}));
      } else {
        couchDbUserProfiles.doc(matchingMember.name).pipe(take(1)).subscribe((userProfileDoc) => {
          couchDbInviteCodes.doc(incoming.invite_code)
            .pipe(take(1))
            .subscribe((invite) => {
              if(!invite.redeemed_by) {
                invite.redeemed_by = `org.couchdb.user:${userProfileDoc._id}`;
                userProfileDoc.roles = ['member', 'freeloader'];
                document.roles = ['member', 'freeloader'];
                zip(
                  couchDbUsers.doc(document),
                  couchDbUserProfiles.doc(userProfileDoc),
                  couchDbInviteCodes.doc(invite),
                ).subscribe((finished) => {
                  res.end(JSON.stringify(finished));
                });

              } else {
                res.end(JSON.stringify({error: 'already_redeemed'}));
              }

            }, (_err) => {
              res.end(JSON.stringify({error: 'no_invite'}));
            });

        });

      }

    }, (_userNotFoundErr) => {
      res.end(JSON.stringify({error: 'no_user'}));
    });

  });

  app.post('/user/:userId/payment', (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    FoundingMemberPayment.strictCheck(req.body);
    const incoming: FoundingMemberPayment = req.body;
    couchDbUsers.doc(req.params.userId).pipe(take(1)).subscribe((document: CouchDBDocument) => {
      let matchingMember: any = document;
      if (matchingMember['stripe_id'] === undefined) {
        res.end(JSON.stringify({ error: 'no_commerce_account' }));
      } else {
        stripe.customers.retrieve(
          matchingMember['stripe_id'],
          (err: any, customer: any) => {
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
                    amount: 10000, // send to api in cents (100 = 1 USD)
                    customer: customer.id,
                    save_payment_method: true,
                    payment_method_types: ['card'],
                    //setup_future_usage: 'off_session',
                    payment_method: paymentMethod.id
                  }, (err: any, _paymentIntent: any) => {
                    if (!err) {
                      // Here's where we make the user full fledged
                      couchDbUserProfiles.doc(matchingMember.name).pipe(take(1)).subscribe((userProfileDoc) => {
                        userProfileDoc.roles = ['member', 'founding_member'];
                        matchingMember.roles = ['member', 'founding_member'];
                        zip(
                          couchDbUsers.doc(matchingMember),
                          couchDbUserProfiles.doc(userProfileDoc),
                          couchDbInviteCodes.doc({
                            _id: Math.random().toString(16).substring(2, 15) + Math.random().toString(16).substring(2, 5),
                            created_by_user: req.params.userId
                          })
                        ).subscribe((finished) => {
                          res.end(JSON.stringify(finished));
                        });

                      });

                    } else {
                      res.end(JSON.stringify(err));
                    }

                  });

                } else {
                  res.end(JSON.stringify(err));
                }

              });

            }

          }

        );
      }

    });

  });

  app.listen(3000, API_BIND_IP);
}

let runningApp: any = null;

startExpress();

export interface ValidatorError {
  field: string;
  message: string;
}

export interface ValidatorResult {
  error: boolean;
  detail?: ValidatorError;
}

export interface Member {
  _id?: string;
  _rev?: string;
  person_name: string;
  name: string;
  password: string;
  password_confirm?: string;
  phone?: string;
  email: string;
}

export interface FoundingMemberPayment {
  cc_name: string;
  cc_number: string;
  cc_exp_month: string;
  cc_exp_year: string;
  cc_zipcode: string;
  cc_terms_agree: boolean;
}

export interface Card {
  account_number: string;
  expiration_month: number;
  expiration_year: number;
}

export interface Invite {
  invite_code: string;
}
export interface ValidatorError {
  field_name: string;
  message: string;
}

export interface ValidatorResult {
  error: boolean;
  detail?: ValidatorError;
}

export interface Member {
  _id?: string;
  _rev?: string;
  name: string;
  username: string;
  password: string;
  password_confirm?: string;
  phone?: string;
  email: string;
}

export interface Card {
  account_number: string;
  expiration_month: number;
  expiration_year: number;
}

export interface Member {
  _id?: string;
  _rev?: string;
  first_name: string;
  last_name: string;
  handle: string;
  phone: string;
  email: string;
}

export interface Card {
  account_number: string;
  expiration_month: number;
  expiration_year: number;
}

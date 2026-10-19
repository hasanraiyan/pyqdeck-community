import { AccountService } from "./account.service.js";

/** Composition root for accounts. Other modules register deletion listeners on this one instance. */
let service: AccountService | undefined;
export const getAccountService = () => (service ??= new AccountService());

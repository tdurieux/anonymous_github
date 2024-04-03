import { model } from "mongoose";

import { IUserDocument, IUserModel } from "./users.types";
import UserSchema from "./users.schema";

const UserModel = model<IUserDocument>("user", UserSchema) as IUserModel;

export default UserModel;

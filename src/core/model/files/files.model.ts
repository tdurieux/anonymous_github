import { model } from "mongoose";

import { IFileDocument, IFileModel } from "./files.types";
import FileSchema from "./files.schema";

const FileModel = model<IFileDocument>("File", FileSchema) as IFileModel;
export default FileModel;

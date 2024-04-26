import { model } from "mongoose";
import { join } from "path";

import { IFileDocument, IFileModel } from "./files.types";
import FileSchema from "./files.schema";

const FileModel = model<IFileDocument>("File", FileSchema) as IFileModel;
export default FileModel;

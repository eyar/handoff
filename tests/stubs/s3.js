// Minimal stand-in for @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
// used by edge functions in tests.

export const s3Stub = {
  commands: [],
  signed: [],
  listContents: [],
  reset() {
    this.commands = [];
    this.signed = [];
    this.listContents = [];
  }
};

export class S3Client {
  constructor(config) {
    this.config = config;
  }
  async send(command) {
    s3Stub.commands.push(command);
    if (command.type === "ListObjectsV2") {
      return {
        Contents: s3Stub.listContents || [],
        $metadata: { httpStatusCode: 200 }
      };
    }
    return { $metadata: { httpStatusCode: 200 } };
  }
}

export class PutObjectCommand {
  constructor(input) {
    this.input = input;
    this.type = "PutObject";
  }
}

export class GetObjectCommand {
  constructor(input) {
    this.input = input;
    this.type = "GetObject";
  }
}

export class DeleteObjectsCommand {
  constructor(input) {
    this.input = input;
    this.type = "DeleteObjects";
  }
}

export class DeleteObjectCommand {
  constructor(input) {
    this.input = input;
    this.type = "DeleteObject";
  }
}

export class ListObjectsV2Command {
  constructor(input) {
    this.input = input;
    this.type = "ListObjectsV2";
  }
}

export class CreateMultipartUploadCommand {
  constructor(input) {
    this.input = input;
    this.type = "CreateMultipartUpload";
  }
}

export class UploadPartCommand {
  constructor(input) {
    this.input = input;
    this.type = "UploadPart";
  }
}

export class ListPartsCommand {
  constructor(input) {
    this.input = input;
    this.type = "ListParts";
  }
}

export class CompleteMultipartUploadCommand {
  constructor(input) {
    this.input = input;
    this.type = "CompleteMultipartUpload";
  }
}

export class ListMultipartUploadsCommand {
  constructor(input) {
    this.input = input;
    this.type = "ListMultipartUploads";
  }
}

export class AbortMultipartUploadCommand {
  constructor(input) {
    this.input = input;
    this.type = "AbortMultipartUpload";
  }
}

export async function getSignedUrl(client, command, options = {}) {
  s3Stub.signed.push({ client, command, options });
  const bucket = command.input?.Bucket || "handoff-files";
  const key = command.input?.Key || "test-key";
  if (command.type === "PutObject") {
    return `https://${bucket}.r2.cloudflarestorage.com/${key}?X-Amz-Signature=mock-put`;
  }
  if (command.type === "DeleteObject") {
    return `https://${bucket}.r2.cloudflarestorage.com/${key}?X-Amz-Signature=mock-delete`;
  }
  if (command.type === "ListObjectsV2") {
    const prefix = command.input?.Prefix || "";
    const token = command.input?.ContinuationToken ? `&continuation-token=${encodeURIComponent(command.input.ContinuationToken)}` : "";
    return `https://${bucket}.r2.cloudflarestorage.com/?prefix=${encodeURIComponent(prefix)}&list-type=2${token}&X-Amz-Signature=mock-list`;
  }
  if (command.type === "ListMultipartUploads") {
    return `https://${bucket}.r2.cloudflarestorage.com/?uploads&X-Amz-Signature=mock-list-uploads`;
  }
  if (["CreateMultipartUpload", "UploadPart", "ListParts", "CompleteMultipartUpload", "AbortMultipartUpload"].includes(command.type)) {
    const part = command.input?.PartNumber ? `&partNumber=${command.input.PartNumber}` : "";
    return `https://${bucket}.r2.cloudflarestorage.com/${key}?op=${command.type}${part}&X-Amz-Signature=mock-mpu`;
  }
  return `https://${bucket}.r2.cloudflarestorage.com/${key}?X-Amz-Signature=mock-get`;
}

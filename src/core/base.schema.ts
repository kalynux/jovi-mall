import { Schema, Document } from 'mongoose';

export interface IBaseDocument extends Document {
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export const BaseSchemaFields = {
  deletedAt: { type: Date, default: null, index: true },
  purgeAt: { type: Date, default: null }
};

export const BaseSchemaOptions = {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: (doc: any, ret: any) => {
      delete ret._id;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    virtuals: true
  }
};

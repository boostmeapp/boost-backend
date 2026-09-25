import { model, Types } from 'mongoose';
import { Call, CallSchema } from './call.schema';
import {
  CallEndReason,
  CallStatus,
  CallType,
} from '../../../modules/call/call.constants';

const CallModel = model<Call>('CallSchemaSpec', CallSchema);

const validCall = () => ({
  streamCallId: `default:${new Types.ObjectId().toString()}`,
  callType: CallType.Video,
  initiator: new Types.ObjectId(),
  participants: [new Types.ObjectId(), new Types.ObjectId()],
});

describe('CallSchema', () => {
  it('accepts a call with all required fields and applies defaults', () => {
    const doc = new CallModel(validCall());

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.status).toBe(CallStatus.Ringing);
    expect(doc.ringStartedAt).toBeInstanceOf(Date);
    expect(doc.rejectedBy).toHaveLength(0);
  });

  it('accepts a fully ended call', () => {
    const doc = new CallModel({
      ...validCall(),
      status: CallStatus.Ended,
      answeredAt: new Date(),
      endedAt: new Date(),
      durationSeconds: 252,
      endedReason: CallEndReason.HungUp,
      endedBy: new Types.ObjectId(),
      metadata: { mos: 4.2 },
    });

    expect(doc.validateSync()).toBeUndefined();
  });

  it.each(['streamCallId', 'callType', 'initiator', 'participants'])(
    'rejects a call without %s',
    (field) => {
      const data: Record<string, unknown> = validCall();
      delete data[field];

      const err = new CallModel(data).validateSync();
      expect(err?.errors[field]).toBeDefined();
    },
  );

  it('rejects fewer than two participants', () => {
    const err = new CallModel({
      ...validCall(),
      participants: [new Types.ObjectId()],
    }).validateSync();

    expect(err?.errors.participants).toBeDefined();
  });

  it('rejects values outside the enums', () => {
    const err = new CallModel({
      ...validCall(),
      callType: 'screen',
      status: 'on_hold',
      endedReason: 'bored',
    }).validateSync();

    expect(err?.errors.callType).toBeDefined();
    expect(err?.errors.status).toBeDefined();
    expect(err?.errors.endedReason).toBeDefined();
  });

  it('rejects a negative duration', () => {
    const err = new CallModel({
      ...validCall(),
      durationSeconds: -1,
    }).validateSync();

    expect(err?.errors.durationSeconds).toBeDefined();
  });

  it('declares the history, sweeper, and unique streamCallId indexes', () => {
    const indexes = CallSchema.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ participants: 1, createdAt: -1 }, expect.anything()],
        [{ status: 1, ringStartedAt: 1 }, expect.anything()],
        [{ streamCallId: 1 }, expect.objectContaining({ unique: true })],
      ]),
    );
  });

  it('has the pagination plugin attached', () => {
    expect(typeof (CallModel as any).paginate).toBe('function');
  });
});

import * as Data from "effect/Data";
export class SpawnFailed extends Data.TaggedError("SpawnFailed") {
}
export class Timeout extends Data.TaggedError("Timeout") {
}
export class ClaimConflict extends Data.TaggedError("ClaimConflict") {
}
export class StoreReadFailed extends Data.TaggedError("StoreReadFailed") {
}
export class StoreWriteFailed extends Data.TaggedError("StoreWriteFailed") {
}
export class InvalidBudget extends Data.TaggedError("InvalidBudget") {
}
export class ReceiptMalformed extends Data.TaggedError("ReceiptMalformed") {
}
export class BatchConfigurationInvalid extends Data.TaggedError("BatchConfigurationInvalid") {
}
export class BatchCancellationFailed extends Data.TaggedError("BatchCancellationFailed") {
}
export class CloudTransportFailed extends Data.TaggedError("CloudTransportFailed") {
}
export class CloudHttpFailed extends Data.TaggedError("CloudHttpFailed") {
}
export class CloudResponseMalformed extends Data.TaggedError("CloudResponseMalformed") {
}
export class CloudPollingExhausted extends Data.TaggedError("CloudPollingExhausted") {
}
export class CloudConfigurationInvalid extends Data.TaggedError("CloudConfigurationInvalid") {
}
export class CloudAdmissionAmbiguous extends Data.TaggedError("CloudAdmissionAmbiguous") {
}
export class CloudReceiptCorrelationFailed extends Data.TaggedError("CloudReceiptCorrelationFailed") {
}

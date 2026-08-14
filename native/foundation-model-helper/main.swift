import Foundation
import FoundationModels

private let foundationModelVersion = "system-language-model"

private struct HelperRequest: Decodable {
    let id: String
    let operation: String
    let systemPrompt: String?
    let userPrompt: String?
    let locale: String?
}

private struct StatusResponse: Encodable {
    let id: String
    let ok = true
    let status: String
    let modelVersion = foundationModelVersion
}

private struct ClassificationResponse: Encodable {
    let id: String
    let ok = true
    let visibleOutput: String
    let classification: ModelClassification
}

private struct ErrorBody: Encodable {
    let code: String
}

private struct ErrorResponse: Encodable {
    let id: String
    let ok = false
    let error: ErrorBody
}

private struct ModelClassification: Codable {
    let decisionIntent: String
    let answerRelation: String
    let question: String?
    let optionLabels: [String]
    let answerExcerpt: String?
    let confidence: Double
}

private enum HelperFailure: Error {
    case invalidRequest
    case modelUnavailable(String)
    case unsupportedLocale
}

private func availabilityCode(
    _ availability: SystemLanguageModel.Availability
) -> String {
    switch availability {
    case .available:
        return "available"
    case .unavailable(.deviceNotEligible):
        return "device_not_eligible"
    case .unavailable(.appleIntelligenceNotEnabled):
        return "apple_intelligence_disabled"
    case .unavailable(.modelNotReady):
        return "assets_unavailable"
    @unknown default:
        return "assets_unavailable"
    }
}

private func encodeLine<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    var data = try encoder.encode(value)
    data.append(0x0A)
    return data
}

private func writeResponse<T: Encodable>(_ value: T) {
    do {
        try FileHandle.standardOutput.write(contentsOf: encodeLine(value))
    } catch {
        FileHandle.standardError.write(
            Data("foundation-helper: output_failed\n".utf8)
        )
    }
}

private func writeError(id: String, code: String) {
    writeResponse(
        ErrorResponse(id: id, error: ErrorBody(code: code))
    )
}

private func classificationSchema() -> GenerationSchema {
    GenerationSchema(
        type: GeneratedContent.self,
        description: "A compact semantic classification. Do not include reasoning.",
        properties: [
            GenerationSchema.Property(
                name: "decisionIntent",
                description: "decision asks the human to choose among viable paths; approval asks permission to proceed; information_request asks for a fact rather than a choice; self_resolved means the assistant already selected the path; none means no human decision is requested.",
                type: String.self,
                guides: [
                    .anyOf([
                        "decision",
                        "approval",
                        "information_request",
                        "self_resolved",
                        "none",
                    ]),
                ]
            ),
            GenerationSchema.Property(
                name: "answerRelation",
                description: "answers means the user directly chooses or approves; mixed means it answers and also adds instructions or a new task; new_task does not answer; uncertain is genuinely ambiguous.",
                type: String.self,
                guides: [
                    .anyOf([
                        "answers",
                        "mixed",
                        "new_task",
                        "uncertain",
                    ]),
                ]
            ),
            GenerationSchema.Property(
                name: "question",
                description: "The exact decision question copied from the assistant text, or nil when there is no decision question.",
                type: String?.self
            ),
            GenerationSchema.Property(
                name: "optionLabels",
                description: "Zero to eight concise option labels stated or clearly contrasted by the assistant. Preserve their source language.",
                type: [String].self,
                guides: [.maximumCount(8)]
            ),
            GenerationSchema.Property(
                name: "answerExcerpt",
                description: "The shortest exact excerpt from the user text that answers the decision, or nil when it does not answer.",
                type: String?.self
            ),
            GenerationSchema.Property(
                name: "confidence",
                description: "Confidence from 0.0 to 1.0 in the complete classification.",
                type: Double.self,
                guides: [.range(0.0...1.0)]
            ),
        ]
    )
}

private func decodeClassification(
    _ content: GeneratedContent
) throws -> ModelClassification {
    ModelClassification(
        decisionIntent: try content.value(
            String.self,
            forProperty: "decisionIntent"
        ),
        answerRelation: try content.value(
            String.self,
            forProperty: "answerRelation"
        ),
        question: try content.value(
            String?.self,
            forProperty: "question"
        ),
        optionLabels: try content.value(
            [String].self,
            forProperty: "optionLabels"
        ),
        answerExcerpt: try content.value(
            String?.self,
            forProperty: "answerExcerpt"
        ),
        confidence: try content.value(
            Double.self,
            forProperty: "confidence"
        )
    )
}

private func classify(_ request: HelperRequest) async throws -> ModelClassification {
    guard
        let systemPrompt = request.systemPrompt,
        let userPrompt = request.userPrompt,
        let localeIdentifier = request.locale
    else {
        throw HelperFailure.invalidRequest
    }

    let model = SystemLanguageModel.default
    let status = availabilityCode(model.availability)
    guard status == "available" else {
        throw HelperFailure.modelUnavailable(status)
    }
    guard model.supportsLocale(Locale(identifier: localeIdentifier)) else {
        throw HelperFailure.unsupportedLocale
    }

    let session = LanguageModelSession(
        model: model,
        instructions: systemPrompt
    )
    let response = try await session.respond(
        to: userPrompt,
        schema: classificationSchema(),
        options: GenerationOptions(
            sampling: .greedy,
            temperature: 0,
            maximumResponseTokens: 512
        )
    )
    return try decodeClassification(response.content)
}

private func visibleOutput(
    _ classification: ModelClassification
) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(classification)
    guard let output = String(data: data, encoding: .utf8) else {
        throw HelperFailure.invalidRequest
    }
    return output
}

private func errorCode(_ error: Error) -> String {
    if let failure = error as? HelperFailure {
        switch failure {
        case .invalidRequest:
            return "invalid_request"
        case .modelUnavailable(let code):
            return code
        case .unsupportedLocale:
            return "unsupported_locale"
        }
    }
    if let generationError = error as? LanguageModelSession.GenerationError {
        switch generationError {
        case .assetsUnavailable:
            return "assets_unavailable"
        case .unsupportedLanguageOrLocale:
            return "unsupported_locale"
        case .guardrailViolation:
            return "guardrail_violation"
        case .refusal:
            return "refusal"
        default:
            return "generation_failed"
        }
    }
    return "generation_failed"
}

@main
private struct FoundationModelHelper {
    static func main() async {
        let decoder = JSONDecoder()
        while let line = readLine(strippingNewline: true) {
            guard
                let data = line.data(using: .utf8),
                let request = try? decoder.decode(
                    HelperRequest.self,
                    from: data
                ),
                !request.id.isEmpty
            else {
                writeError(id: "unknown", code: "invalid_request")
                continue
            }

            switch request.operation {
            case "status":
                writeResponse(
                    StatusResponse(
                        id: request.id,
                        status: availabilityCode(
                            SystemLanguageModel.default.availability
                        )
                    )
                )
            case "classify":
                do {
                    let result = try await classify(request)
                    writeResponse(
                        ClassificationResponse(
                            id: request.id,
                            visibleOutput: try visibleOutput(result),
                            classification: result
                        )
                    )
                } catch {
                    writeError(
                        id: request.id,
                        code: errorCode(error)
                    )
                }
            default:
                writeError(
                    id: request.id,
                    code: "unsupported_operation"
                )
            }
        }
    }
}

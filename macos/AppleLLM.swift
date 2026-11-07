// Drafts text with the on-device Apple Intelligence model.
// Reads the prompt from stdin and writes the reply to stdout.
import Foundation
import FoundationModels

@main
struct AppleLLM {
    static func main() async {
        let prompt = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            fail("Apple Intelligence is not available on this Mac (\(model.availability)).")
        }
        do {
            let response = try await LanguageModelSession(model: model).respond(to: prompt)
            print(response.content)
        } catch LanguageModelSession.GenerationError.exceededContextWindowSize {
            fail("The listing is too long for the Apple Intelligence model.")
        } catch LanguageModelSession.GenerationError.guardrailViolation {
            fail("The Apple Intelligence model declined to write this message.")
        } catch LanguageModelSession.GenerationError.refusal {
            fail("The Apple Intelligence model declined to write this message.")
        } catch {
            fail("Apple Intelligence failed. \(error.localizedDescription)")
        }
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data(message.utf8))
        exit(1)
    }
}

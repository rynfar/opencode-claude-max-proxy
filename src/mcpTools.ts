import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { glob as globLib } from "glob"

const execAsync = promisify(exec)

const getCwd = () => process.env.CLAUDE_PROXY_WORKDIR || process.cwd()

export const opencodeMcpServer = createSdkMcpServer({
  name: "opencode",
  version: "1.0.0",
  tools: [
    tool(
      "read",
      "Read the contents of a file at the specified path",
      {
        path: z.string().describe("Absolute or relative path to the file"),
        encoding: z.string().optional().describe("File encoding, defaults to utf-8")
      },
      async (args) => {
        try {
          const filePath = path.isAbsolute(args.path) 
            ? args.path 
            : path.resolve(getCwd(), args.path)
          const content = await fs.readFile(filePath, (args.encoding || "utf-8") as BufferEncoding)
          return {
            content: [{ type: "text", text: content }]
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error reading file: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          }
        }
      }
    ),
    
    tool(
      "write",
      "Write content to a file, creating directories if needed",
      {
        path: z.string().describe("Path to write to"),
        content: z.string().describe("Content to write")
      },
      async (args) => {
        try {
          const filePath = path.isAbsolute(args.path)
            ? args.path
            : path.resolve(getCwd(), args.path)
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, args.content, "utf-8")
          return {
            content: [{ type: "text", text: `Successfully wrote to ${args.path}` }]
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error writing file: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          }
        }
      }
    ),
    
    tool(
      "edit",
      "Edit a file by replacing oldString with newString",
      {
        path: z.string().describe("Path to the file to edit"),
        oldString: z.string().describe("The text to replace"),
        newString: z.string().describe("The replacement text")
      },
      async (args) => {
        try {
          const filePath = path.isAbsolute(args.path)
            ? args.path
            : path.resolve(getCwd(), args.path)
          const content = await fs.readFile(filePath, "utf-8")
          if (!content.includes(args.oldString)) {
            return {
              content: [{ type: "text", text: `Error: oldString not found in file` }],
              isError: true
            }
          }
          const newContent = content.replace(args.oldString, args.newString)
          await fs.writeFile(filePath, newContent, "utf-8")
          return {
            content: [{ type: "text", text: `Successfully edited ${args.path}` }]
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error editing file: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          }
        }
      }
    ),
    
    tool(
      "bash",
      "Execute a bash command and return the output",
      {
        command: z.string().describe("The command to execute"),
        cwd: z.string().optional().describe("Working directory for the command")
      },
      async (args) => {
        try {
          const options = { 
            cwd: args.cwd || getCwd(),
            timeout: 120000
          }
          const { stdout, stderr } = await execAsync(args.command, options)
          const output = stdout || stderr || "(no output)"
          return {
            content: [{ type: "text", text: output }]
          }
        } catch (error: unknown) {
          const execError = error as { stdout?: string; stderr?: string; message?: string }
          const output = execError.stdout || execError.stderr || execError.message || String(error)
          return {
            content: [{ type: "text", text: output }],
            isError: true
          }
        }
      }
    ),
    
    tool(
      "glob",
      "Find files matching a glob pattern",
      {
        pattern: z.string().describe("Glob pattern like **/*.ts"),
        cwd: z.string().optional().describe("Base directory for the search")
      },
      async (args) => {
        try {
          const files = await globLib(args.pattern, {
            cwd: args.cwd || getCwd(),
            nodir: true,
            ignore: ["**/node_modules/**", "**/.git/**"]
          })
          return {
            content: [{ type: "text", text: files.join("\n") || "(no matches)" }]
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          }
        }
      }
    ),
    
    tool(
      "grep",
      "Search for a pattern in files",
      {
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Directory or file to search in"),
        include: z.string().optional().describe("File pattern to include, e.g., *.ts")
      },
      async (args) => {
        try {
          const searchPath = args.path || getCwd()
          const includePattern = args.include || "*"
          
          let cmd = `grep -rn --include="${includePattern}" "${args.pattern}" "${searchPath}" 2>/dev/null || true`
          const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
          
          return {
            content: [{ type: "text", text: stdout || "(no matches)" }]
          }
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true
          }
        }
      }
    )
  ]
})

# Literature Findings (verified)

Each finding below was proposed by a research finder agent and then
independently checked by skeptic agents that fetched the source URL.
Only findings whose source page was confirmed to support the claim are kept.
See verification-log.md for what was dropped and why.

Total verified findings: 78.

## General software engineering: code generation, repair, debugging

1. When SWE-bench launched in 2023 (ICLR 2024), the best frontier model (Claude 2) resolved only 1.96% of the 2,294 real GitHub issue task instances, showing models initially could solve almost no realistic repository-level software-engineering tasks.
   - Source: SWE-bench: Can Language Models Resolve Real-World GitHub Issues?, 2024
   - URL: https://openreview.net/pdf?id=VTF8yNQM66
   - Evidence: "We evaluate multiple state-of-the-art LMs on SWE-bench and find that they fail to solve all except the simplest issues. Using a BM25 retriever, Claude 2 is only able to resolve 1.96% of the issues."
   - Cluster: swe-bench

2. Failure analysis of agent-generated patches reveals a semantic-reasoning weakness rather than a syntax weakness: logic errors (47%) and incomplete fixes (35%) dominate, while surface-level syntactic errors (type mismatches, boundary violations, off-by-one) account for only about 14%. Agents tend to produce shallow solutions that pass explicit tests without achieving semantic completeness.
   - Source: SWE-ABS: Adversarial Benchmark Strengthening Exposes Inflated Success Rates on Test-based Benchmark, 2026
   - URL: https://arxiv.org/pdf/2603.00520
   - Evidence: "Logic errors (47%) dominate ... Incomplete fixes (35%) are also frequent ... suggesting that AI systems tend to generate shallow solutions that satisfy explicit tests without achieving semantic completeness."
   - Cluster: swe-bench

3. FixAgent/UniDebugger, a hierarchical multi-agent debugging framework, sets a new state of the art on Defects4J by correctly fixing 197 bugs (286 plausible fixes), outperforming the prior SoTA ChatRepair by about 25.48 percent, and fixes all bugs in QuixBugs across two languages (Java and Python). Default backbone is GPT-4o.
   - Source: UniDebugger (FixAgent): Hierarchical Multi-Agent Framework for Unified Software Debugging, 2024
   - URL: https://arxiv.org/abs/2404.17153
   - Evidence: "On Defects4J, FixAgent achieves a new state-of-the-art (SoTA) by correctly fixing 197 bugs with 286 plausible fixes ... outperforming the SoTA, ChatRepair, by ~25.48% ... FixAgent successfully fixes all bugs in QuixBugs across two programming languages. The default backbone of FixAgent is gpt-4o."
   - Cluster: multiagent-debug

4. FixAgent/UniDebugger fixes 1.25x to 2.56x more bugs than state-of-the-art repair methods on the repository-level Defects4J benchmark, and does so end-to-end without requiring prior fault localization.
   - Source: UniDebugger (FixAgent): Hierarchical Multi-Agent Framework for Unified Software Debugging (EMNLP 2025), 2025
   - URL: https://aclanthology.org/2025.emnlp-main.921/
   - Evidence: "fixing 1.25x to 2.56x bugs on the repo-level benchmark, Defects4J"
   - Cluster: multiagent-debug

5. RepairAgent's closed-loop write-run-validate iteration is cheap: it averages 270,000 tokens per bug, which at GPT-3.5 pricing is about 14 cents (USD) per bug repaired, demonstrating cost-efficient automated repair.
   - Source: RepairAgent: An Autonomous, LLM-Based Agent for Program Repair, 2024
   - URL: https://arxiv.org/abs/2403.17134
   - Evidence: "an average cost of 270,000 tokens per bug, which, under the current pricing of OpenAI's GPT-3.5 model, translates to 14 cents of USD per bug."
   - Cluster: multiagent-debug

6. RGD, a multi-LLM agent debugger using three specialized agents (Guide, Debug, Feedback) with iterative refinement and self-reflection, achieves state-of-the-art with a 9.8 percent improvement on HumanEval and a 16.2 percent improvement on MBPP over prior approaches.
   - Source: RGD: Multi-LLM Based Agent Debugger via Refinement and Generation Guidance, 2024
   - URL: https://arxiv.org/abs/2410.01242
   - Evidence: "achieving state-of-the-art performance with a 9.8% improvement on the HumanEval dataset and a 16.2% improvement on the MBPP dataset compared to the state-of-the-art approaches and traditional direct prompting approaches."
   - Cluster: multiagent-debug

7. An ablation of RGD shows the multi-agent decomposition matters: removing the Guide Agent drops performance by 4.4 percent on HumanEval and 6.4 percent on MBPP, and removing the failure-feedback component drops MBPP by up to 9.8 percent, indicating the specialized-agent design (not just the LLM) drives the gains.
   - Source: RGD: Multi-LLM Based Agent Debugger via Refinement and Generation Guidance, 2024
   - URL: https://arxiv.org/html/2410.01242v2
   - Evidence: "the Guide Agent ... removal leading to a 4.4% drop on HumanEval and a 6.4% drop on MBPP ... Failure Feedback ... removal causing performance drops especially on MBPP (up to 9.8%)."
   - Cluster: multiagent-debug

8. CodeSim, a multi-agent framework covering planning, coding, and debugging with simulation-driven plan verification and internal debugging via step-by-step input/output simulation, reaches new state-of-the-art pass@1 results of HumanEval 95.1 percent, MBPP 90.7 percent, APPS 22 percent, and CodeContests 29.1 percent.
   - Source: CodeSim: Multi-Agent Code Generation and Problem Solving through Simulation-Driven Planning and Debugging (NAACL 2025 Findings), 2025
   - URL: https://arxiv.org/abs/2502.05664
   - Evidence: "Our framework achieves new state-of-the-art (pass@1) results-(HumanEval 95.1%, MBPP 90.7%, APPS 22%, and CodeContests 29.1%)."
   - Cluster: multiagent-debug

9. ChatDev reports high executability (0.88) but only moderate completeness (0.56), meaning roughly 44 percent of generated software is incomplete, and the authors explicitly warn the systems suit prototypes not complex real-world applications.
   - Source: ChatDev: Communicative Agents for Software Development, 2023
   - URL: https://arxiv.org/html/2307.07924v5
   - Evidence: "ChatDev executability 0.8800, completeness 0.5600; authors state these technologies are 'more suitable for prototype systems rather than complex real-world applications' and that 'the capabilities of autonomous agents in software production might be overestimated.'"
   - Cluster: multiagent-devframeworks

10. MetaGPT reaches state-of-the-art code generation (85.9 percent Pass@1 on HumanEval, 87.7 percent on MBPP) and a near-flawless 3.75 of 4 executability on SoftwareDev, but consumes 31,255 tokens per task versus ChatDev's 19,292, trading more communication for quality.
   - Source: MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework, 2023
   - URL: https://arxiv.org/html/2308.00352v6
   - Evidence: "HumanEval 85.9% Pass@1, MBPP 87.7% Pass@1; SoftwareDev executability 3.75/4 vs ChatDev 2.25; 31,255 tokens vs ChatDev 19,292."
   - Cluster: multiagent-devframeworks

11. LLM-based ROS2 architecture recovery scored perfect precision/recall/F1 of 1.0 on low-level deterministic atomic-node extraction in synthetic cases, but recall collapsed at higher composed/integration abstraction levels in the real industrial Autoware subset (composed-level F1 dropped to 0.49, recall 0.35), showing strength at structural code parsing but weakness at higher-level integration semantics.
   - Source: Modeling and Recovering Hierarchical Structural Architectures of ROS 2 Systems from Code and Launch Configurations using LLM-based Agents, 2026
   - URL: https://arxiv.org/abs/2602.18644
   - Evidence: "Recall decreases for higher abstraction levels in larger repositories, because subsystem composition and integration semantics are often dispersed and implicitly encoded."
   - Cluster: ros-llm-tools

12. OperateLLM integrates ROS2 tools into an LLM via the ReAct prompting method using DeepSeek Coder v2 and the rclpy Python API, successfully generating fundamental ROS2 software components such as Nodes and Publishers, illustrating the software-engineering-side strength of agents at writing ROS2 boilerplate.
   - Source: OperateLLM: Integrating Robot Operating System (ROS) Tools in Large Language Models, 2024
   - URL: https://ieeexplore.ieee.org/document/10730448/
   - Evidence: "OperateLLM has shown the ability to create fundamental ROS 2 components such as Nodes and Publishers and employs the ReAct method of prompting to integrate ROS2 with LLMs."
   - Cluster: ros-llm-tools

13. robotics-agent-skills (grey literature, GitHub) packages production robotics knowledge as SKILL.md files for named commercial coding agents (Claude Code, Cursor, GitHub Copilot) to improve ROS1/ROS2 software engineering. Its evaluation report shows skills-enabled generation produced 601 lines of tests (vs 0), upgraded plain nodes to lifecycle nodes, added sensor/reliable QoS handling, expanded configuration from 4 to 13 parameters, and added thread-safe bounded buffers and watchdogs, evidence agents are strong on the SWE side of robotics.
   - Source: robotics-agent-skills (Agent skills for production-grade robotics software for Claude Code, Cursor, Copilot), 2026
   - URL: https://github.com/arpitg1304/robotics-agent-skills
   - Evidence: "Tests: 0 lines to 601 lines; Configuration parameters: 4 to 13; Sensor management: simple assignment to thread-safe bounded buffers, drop counts, watchdogs."
   - Cluster: named-tools-robotics

## Robotics-specific code generation and debugging

14. ROS Help Desk (CSIRO Data61) achieved 100% accuracy at DETECTING which injected error type occurred, but only 18% accuracy at the harder task of correctly identifying the specific intentionally injected fault (root cause), a near-perfect detection vs weak root-cause gap that directly supports the thesis.
   - Source: ROS Help Desk: GenAI Powered, User-Centric Framework for ROS Error Diagnosis and Debugging, 2025
   - URL: https://arxiv.org/abs/2507.07846
   - Evidence: "Across all injected error types, the ROS Help Desk successfully identified the correct error 100% of the time; identifying intentionally injected faults scored only 18% accuracy."
   - Cluster: ros-llm-tools

15. ROS Help Desk averaged 68% across eight debugging assessment criteria; analysis, diagnostics, validation, and recommendation dimensions each exceeded 50%, while its proactive-detection baseline comparison showed ROSA reaching only 29% detection accuracy versus Help Desk's 100%.
   - Source: ROS Help Desk: GenAI Powered, User-Centric Framework for ROS Error Diagnosis and Debugging, 2025
   - URL: https://arxiv.org/html/2507.07846v1
   - Evidence: "ROSA baseline (when queried) achieved only 29% accuracy; average performance across all assessment criteria: 68%."
   - Cluster: ros-llm-tools

16. RoboCoach-Bench is a 32-task benchmark drawn from four simulation platforms (ManiSkill3, RoboTwin2, Robomimic, MetaWorld) with expert-authored reference policies, plus real-robot transfer experiments; across seven frontier LLMs the agentic loop matches and in aggregate exceeds the platform references under binary task-completion criteria.
   - Source: From Digital to Physical: Digital Agents as Autonomous Coaches for Physical Intelligence, 2026
   - URL: https://arxiv.org/html/2601.21570
   - Evidence: "RoboCoach-Bench, a 32-task benchmark spanning four simulation platforms with expert-authored references... Across seven frontier language models, RoboCoach matches and, in aggregate, exceeds platform references under binary task-completion criteria."
   - Cluster: robot-policy-loops

17. The RoboCoach gains come from the closed-loop machinery (execution feedback, training signals, rollout-video diagnostics, memory and search) rather than raw model strength alone; the agentic agents surpass human-engineered baselines by 26.5% in average success rate and can resurrect near-total failures through iterative simulation-in-the-loop debugging.
   - Source: From Digital to Physical: Digital Agents as Autonomous Coaches for Physical Intelligence, 2026
   - URL: https://arxiv.org/abs/2601.21570
   - Evidence: "Ablations show that the gains come from the closed-loop framework-execution feedback, training signals, rollout-video diagnostics, memory and search-not only from model strength."
   - Cluster: robot-policy-loops

18. RoboCoach-optimized policies transfer to physical hardware in two robot laboratories: averaged over four transfer tasks, RoboCoach improves simulation success from 0.53 to 0.64 and real-robot success from 0.51 to 0.68, showing the sim gains survive the sim-to-real gap.
   - Source: From Digital to Physical: Digital Agents as Autonomous Coaches for Physical Intelligence, 2026
   - URL: https://arxiv.org/html/2601.21570
   - Evidence: "Averaged over the four transfer tasks, RoboCoach improves the simulation success rate from 0.53 to 0.64 and the real-robot success rate from 0.51 to 0.68."
   - Cluster: robot-policy-loops

19. FAEA (Frontier Agent as Embodied Agent) applies an unmodified software-engineering LLM agent framework (Claude Agent SDK) directly to embodied manipulation, using the same iterative debugging loop that lets software agents fix code, achieving 84.9% (LIBERO), 85.7% (ManiSkill3), and 96% (MetaWorld) with privileged state access and zero demonstrations.
   - Source: Demonstration-Free Robotic Control via LLM Agents (FAEA), 2026
   - URL: https://arxiv.org/abs/2601.20334
   - Evidence: "FAEA (Frontier Agent as Embodied Agent), which applies an LLM agent framework directly to embodied manipulation without modification... With privileged environment state access, FAEA achieves success rates of 84.9%, 85.7%, and 96%, respectively."
   - Cluster: robot-policy-loops

20. FAEA's zero-demonstration agentic loop approaches the performance of VLA models trained with under 100 demonstrations per task, and one optional round of human feedback raises LIBERO from 84.9% to 88.2%, demonstrating the non-agentic-to-coached lift.
   - Source: Demonstration-Free Robotic Control via LLM Agents (FAEA), 2026
   - URL: https://arxiv.org/abs/2601.20334
   - Evidence: "This level of task success approaches that of VLA models trained with less than 100 demonstrations per task, without requiring demonstrations or fine-tuning. With one round of human feedback as an optional optimization, performance increases to 88.2% on LIBERO."
   - Cluster: robot-policy-loops

21. NASA JPL's ROSA (arXiv, 2024) is an LLM agent (LangChain + ReAct) for inspecting, diagnosing, and operating ROS1/ROS2 systems, demonstrated on NeBula-Spot, EELS, and NVIDIA Nova Carter. The paper explicitly limits the agent to an operator interface over existing functionality rather than direct embodied control: it cannot autonomously interpret commands like 'move toward the rock' and still requires waypoint coordinates, directly supporting the weak-embodied-brain thesis.
   - Source: Enabling Novel Mission Operations and Interactions with ROSA: The Robot Operating System Agent, 2024
   - URL: https://arxiv.org/abs/2410.06472
   - Evidence: "ROSA functions as an operator interface that leverages existing robot functionality within the ROS ecosystem rather than enabling direct LLM-based robotic control... ROSA cannot autonomously interpret commands like move toward the rock without structured input."
   - Cluster: named-tools-robotics

22. On the robotics-specific agentic-coding side, the CodeBotler/RoboEval study shows the exact split in the working thesis: LLMs handle the code-structure/DSL side well (GPT-4 ~67.5% pass@1, and code-trained models produce fewer syntax errors) but fail on the embodied side, with 33.7-80.5% of execution errors being hallucinated invalid locations/objects and recurring failures in spatial state tracking (e.g., forgetting to store initial location for a 'come back' instruction).
   - Source: Deploying and Evaluating LLMs to Program Service Mobile Robots (CodeBotler / RoboEval), 2024
   - URL: https://arxiv.org/abs/2311.11183
   - Evidence: "GPT-4 generates correct programs for ~67.5% of prompts, yet 33.7-80.5% of robot execution errors involve invalid locations or objects, and models fail spatial state tracking such as the 'come back' instruction because they forget to store the initial location."
   - Cluster: production-agentic-2026

23. Evidence that HIGH-LEVEL multi-robot task planning (decompose, form coalitions, allocate) can work while low-level coordination stays the hard part: SMART-LLM converts language instructions into multi-robot plans via task decomposition, coalition formation, and task allocation, reaching a 70% success rate on compound and complex tasks across LLM backbones in simulation and real-world tests. The LLM does symbolic allocation, not coordinated sensorimotor execution.
   - Source: SMART-LLM: Smart Multi-Agent Robot Task Planning using Large Language Models, 2023
   - URL: https://arxiv.org/abs/2309.10062
   - Evidence: "task decomposition, coalition formation, and task allocation ... For compound and complex tasks, the method consistently achieves favorable results across all LLM backbones, with a success rate of 70%."
   - Cluster: multirobot-coordination-runtime

24. LLMs help multi-robot coordination only when restricted to high-level deadlock strategy on top of a low-level planner that handles collision-free motion. In LLMDR, the LLM detects deadlocks and sets agent priorities while PIBT executes collision-free actions; on a 64-agent warehouse map this raised learned-MAPF success from a near-total collapse to usable levels (DHC 1% to 83%, DCC 14% to 74%, EPH* 6% to 68%). The baseline learned coordinators deadlocked so badly that the LLM was needed as a rescue layer, not a primary controller.
   - Source: LLMDR: LLM-Driven Deadlock Detection and Resolution in Multi-Agent Pathfinding, 2025
   - URL: https://arxiv.org/abs/2503.00717
   - Evidence: "DHC baseline: 1% success rate -> DHC+LLMDR: 83% ... DCC baseline: 14% -> DCC+LLMDR: 74% ... EPH* baseline: 6% -> EPH*+LLMDR: 68% ... many failures in learned MAPF models stem from deadlocks."
   - Cluster: multirobot-coordination-runtime

25. ROSClaw documents a distinct embodied failure mode where the LLM repeatedly reissues a blocked command without adapting parameters: replan loops occurred in 19% of cases overall, rising to 31% for Llama 4 (vs 4% for Claude), and the system has no automatic loop-breaker to escape them.
   - Source: ROSClaw: An OpenClaw ROS 2 Framework for Agentic Robot Control and Interaction, 2026
   - URL: https://arxiv.org/html/2603.26997v1
   - Evidence: "replan loops where the model repeatedly reissues blocked commands without adapting parameters (19% overall; Claude 4%, Llama 4 31%) ... ROSClaw currently has no automatic loop-breaker; adding a configurable max-retry threshold that forces a fallback or e-stop is planned"
   - Cluster: runtime-error-recovery-failures

26. In ROSClaw, when an action is blocked by the safety/executive layer the agent is forced to replan, but failure recovery has no bounded semantics: the LLM autonomously decides whether to retry, skip, or replan with no contract on which recovery actions are valid and no bound on attempts, which is what produces the unbounded replan loops.
   - Source: ROSClaw: An OpenClaw ROS 2 Framework for Agentic Robot Control and Interaction, 2026
   - URL: https://arxiv.org/html/2603.26997v1
   - Evidence: "Blocked actions return rtr to force replanning ... Failure recovery has no bounded semantics, the LLM autonomously decides whether to retry, skip, or replan, with no explicit contract specifying which recovery actions are available for which failure types and no bound on how many attempts may be made."
   - Cluster: runtime-error-recovery-failures

27. CodeBotler/RoboEval shows LLM-generated robot programs fail at runtime state tracking: a recurring failure class requires the program to be aware of the robot's internal state or external world state (PlaceNoObject, PickWhileHolding, AskNoPerson), e.g. failing to record the start location with get_current_location so the robot cannot return.
   - Source: Deploying and Evaluating LLMs to Program Service Mobile Robots (CodeBotler / RoboEval), 2024
   - URL: https://arxiv.org/html/2311.11183v3
   - Evidence: "Programs that fail the 'come back' instruction often do not use the get_current_location primitive to record the robot's starting location, and as a result, cannot refer to the starting location at the end of the program."
   - Cluster: runtime-error-recovery-failures

28. RoboEval quantifies that even the best LLM-written robot programs are unreliable and non-robust: GPT-4 reached pass@1 >= 0.75 on only 67.5% of prompts (GPT-3.5 43.75%, StarCoder 28.75%), with hallucinated arguments (invalid locations/objects) dominating robot execution errors (up to 80.5% for StarCoder), showing the closed-loop generation does not catch embodied-grounding errors.
   - Source: Deploying and Evaluating LLMs to Program Service Mobile Robots (CodeBotler / RoboEval), 2024
   - URL: https://arxiv.org/abs/2311.11183
   - Evidence: "GPT-4: 67.5% of prompts achieve pass@1 score >= 0.75 ... For robot execution errors, hallucinated arguments account for: StarCoder 80.5% ... These involve invalid locations or objects the robot cannot access."
   - Cluster: runtime-error-recovery-failures

29. ROS Help Desk, a GenAI framework built on ROSA for ROS error diagnosis and debugging, achieved 100% accuracy at proactively detecting injected ROS faults (lidar drop/delay/corruption, image faults, node crashes) versus 29% for the queried ROSA baseline, but its true-cause identification was only 18%, showing agents are strong at surface ROS error detection yet weak at deep robotics root-cause analysis.
   - Source: ROS Help Desk: GenAI Powered, User-Centric Framework for ROS Error Diagnosis and Debugging, 2025
   - URL: https://arxiv.org/html/2507.07846v1
   - Evidence: "Proactive error detection: 100% accuracy across all injected error types; ROSA baseline (queried): 29% accuracy ... true cause identification 18%. Errors handled: sensor faults, communication faults (message loss and delays), node crashes, parameter misconfigurations, missing sensor frames and invalid point cloud returns. Evaluated in Gazebo with TurtleBot3 via YAML fault injection."
   - Cluster: ros-bug-repair-real-code

30. An LLM-based agent pipeline recovers hierarchical structural architecture models of real ROS 2 systems directly from source code and launch files, evaluated on three ROS 2 repositories including an industrial-scale subset, parsing nodes, topics, interfaces and launch-induced wiring with high precision, demonstrating agents can read and reason over real ROS 2 codebases.
   - Source: Modeling and Recovering Hierarchical Structural Architectures of ROS 2 Systems from Code and Launch Configurations using LLM-based Agents, 2026
   - URL: https://arxiv.org/abs/2602.18644
   - Evidence: "automated recovery pipeline that reconstructs such models from code and configuration artifacts by combining deterministic extraction with LLM-based agents ... evaluated three ROS 2 repositories, including an industrial-scale code subset ... high precision across abstraction levels, while subsystem-level recall drops with repository complexity due to implicit launch semantics."
   - Cluster: ros-bug-repair-real-code

31. A closed-loop generate-simulate-evaluate LLM framework for drone/UAV operation code raised task success from 33.3-55% (direct generation, no correction) to 85-93.3% with iterative error-fix correction across UAV systems, evidence that write-run-read-error-fix loops sharply improve real robot control code, evaluated in AirSim and PX4-Gazebo.
   - Source: LLM-Driven Corrective Robot Operation Code Generation with Static Text-Based Simulation, 2025
   - URL: https://arxiv.org/html/2512.02002v1
   - Evidence: "With correction (proposed method): 85-93.3% success rate across UAV systems; Without correction (Direct Analysis baseline): 33.3-55% success rate ... iterative generation-simulation-evaluation process ... continues until the evaluation confirms task objectives are achieved. LLMs: o3-mini and o4-mini on 20 UAV operation tasks."
   - Cluster: ros-bug-repair-real-code

32. RoboRepair traces execution of an LLM-generated robot program up to the point of failure and runs an LLM-produced recovery program, evaluated on a benchmark of eleven robot tasks with various error conditions requiring recovery, addressing faulty programs caused by instruction ambiguity, task misinterpretation, or missing world-state information.
   - Source: Creating and Repairing Robot Programs in Open-World Domains, 2024
   - URL: https://arxiv.org/abs/2410.18893
   - Evidence: "RoboRepair, a system which traces the execution of a program up until error, and then runs an LLM-produced recovery program that minimizes repeated actions ... we create a benchmark consisting of eleven tasks with various error conditions that require the generation of a recovery program."
   - Cluster: ros-bug-repair-real-code

## Embodied control: where LLMs and VLMs remain weak

33. A study of 1,642 traces across 7 multi-agent frameworks (MAST taxonomy) attributes 23.6 percent of all failures to the task-verification category (incorrect verification 9.1 percent, no/incomplete verification 8.2 percent, premature termination 6.2 percent), confirming weak tester/reviewer roles as a systematic failure source, with overall failure rates of 41 to 86.7 percent.
   - Source: Why Do Multi-Agent LLM Systems Fail?, 2025
   - URL: https://arxiv.org/html/2503.13657v3
   - Evidence: "FC3 Task Verification 23.6% of failures; 'many existing verifiers perform only superficial checks'; MAS frameworks demonstrated 41% to 86.7% failure rates."
   - Cluster: multiagent-devframeworks

34. ROS-LLM (embodied-AI ROS framework) was evaluated on 35 manually created tabletop rearrangement tasks plus a 12-step coffee-making long-horizon task using only an open-source Deepseek 7B Coder, and task success at higher difficulty depended heavily on human feedback, with success declining as complexity increased absent intervention.
   - Source: ROS-LLM: A ROS framework for embodied AI with task feedback and structured reasoning, 2024
   - URL: https://arxiv.org/abs/2406.19741
   - Evidence: "35 tasks were manually created; the inclusion of human feedback generally leads to improved task success rates across varying levels of difficulty."
   - Cluster: ros-llm-tools

35. EmbodiedBench shows spatial reasoning collapses specifically in low-level manipulation: GPT-4o scores 52% (ALFRED) and 36% (Habitat) on spatial-awareness subsets at the high level but only 25.0% on the EB-Manipulation spatial-awareness subset and 19.4% on its visual-appearance subset.
   - Source: EmbodiedBench (arXiv:2502.09560), HTML full text, 2025
   - URL: https://arxiv.org/html/2502.09560v1
   - Evidence: "EB-Manipulation subsets (GPT-4o): Spatial Awareness 25.0%, Visual Appearance 19.4%; versus EB-ALFRED Spatial Awareness 52%."
   - Cluster: embodied-benchmarks

36. On Butter-Bench (real robot, LLM as high-level controller isolated from the VLA), the best LLM (Gemini 2.5 Pro) scores 40% versus a mean human score of 95%; rankings fall to Claude Opus 4.1 37%, GPT-5 30%, Grok 4 23%, Llama 4 Maverick 7%.
   - Source: Butter-Bench: Evaluating LLM Controlled Robots for Practical Intelligence, 2025
   - URL: https://arxiv.org/html/2510.21860v1
   - Evidence: "The best LLMs score 40% on Butter-Bench, while the mean human score is 95%. Gemini 2.5 Pro 40%, Claude Opus 4.1 37%, GPT-5 30%, Gemini ER 1.5 27%, Grok 4 23%, Llama 4 Maverick 7%."
   - Cluster: embodied-benchmarks

37. On PARTNR (Meta FAIR, 100,000 multi-agent human-robot collaboration tasks), humans solve 93% of tasks but SoTA LLMs complete only 30% under non-privileged (no ground-truth) conditions, with documented failures in coordination, task tracking, and error recovery.
   - Source: PARTNR: A Benchmark for Planning and Reasoning in Embodied Multi-agent Tasks, 2024
   - URL: https://arxiv.org/abs/2411.00081
   - Evidence: "While humans are able to solve 93% of PARTNR tasks, SoTA LLMs can only successfully complete 30% under non-privileged conditions... poor coordination and failures in task tracking and recovery from errors."
   - Cluster: embodied-benchmarks

38. On RoboBench (MLLM as embodied brain; 14 capabilities, 25 tasks, 6,092 QA pairs across 14 SoTA MLLMs), the strongest model Gemini-2.5-Pro still lags behind humans, and all models degrade severely on implicit instructions with average scores dropping by about 30%.
   - Source: RoboBench: A Comprehensive Evaluation Benchmark for Multimodal Large Language Models as Embodied Brain, 2025
   - URL: https://arxiv.org/abs/2510.17801
   - Evidence: "Gemini-2.5-Pro... clearly outperforming both other closed- and open-source MLLMs, though it still lags behind humans. Models exhibit severe degradation on implicit instructions, with average scores dropping by 30%."
   - Cluster: embodied-benchmarks

39. On VLABench (long-horizon language-conditioned manipulation), SoTA VLA models perform near zero on composite tasks: Octo 0.00%, OpenVLA 2.66%, RDT-1B 3.34% average success, confirming pretrained VLAs lack the generalization seen in LLMs.
   - Source: VLABench: A Large-Scale Benchmark for Language-Conditioned Robotics Manipulation with Long-Horizon Reasoning Tasks, 2024
   - URL: https://arxiv.org/html/2412.18194v1
   - Evidence: "On composite tasks: Octo 0.00%, OpenVLA 2.66%, RDT-1B 3.34% average success... current pre-trained VLAs have yet to exhibit the strong generalization capabilities observed in LLMs."
   - Cluster: embodied-benchmarks

40. On BLINK (3,807 multiple-choice visual perception questions including relative depth, spatial relations, and multi-view reasoning), humans average 95.70% while GPT-4V reaches only 51.26% and Gemini 45.72% (just 7.63 points above random), a roughly 44 point human-model gap on core spatial perception.
   - Source: BLINK: Multimodal Large Language Models Can See but Not Perceive (ECCV 2024), 2024
   - URL: https://arxiv.org/abs/2404.12390
   - Evidence: "While humans achieve 95.70% accuracy on average, GPT-4V achieves an accuracy of 51.26%... Gemini achieves 45.72% accuracy, which is only 7.63% higher than random guessing."
   - Cluster: embodied-benchmarks

41. ROSClaw documents poor runtime error recovery in agentic robot control: models entered replan loops, repeatedly reissuing blocked commands without adapting parameters in 19% of cases overall (Claude 4%, Llama 4 31%), and malformed/structured-command serialization failures accounted for 38% of Llama 4 failures vs 8% for Claude. This supports the thesis that agents are weak at sensorimotor/structured-action execution and recovery even when high-level reasoning is sound.
   - Source: ROSClaw: An OpenClaw ROS 2 Framework for Agentic Robot Control and Interaction, 2026
   - URL: https://arxiv.org/html/2603.26997v1
   - Evidence: "replan loops where the model repeatedly reissued blocked commands without adapting parameters (19% overall; Claude 4%, Llama 4 31%); malformed tool parameters accounted for 38% of Llama 4 failures versus only 8% for Claude."
   - Cluster: named-tools-robotics

42. ROSClaw found large cross-model safety divergence in embodied action proposal: Llama 4 triggered at least one safety-validator block in 43% of prompts (4.8x GPT-5.2's 9%; Claude 14%, Gemini 31%), and models struggled with platform-specific action interfaces, e.g. on the humanoid Llama 4 called ros2_publish on topics requiring an action server in 41% of failed trials. All out-of-policy actions were intercepted pre-execution (100% blocking), meaning the safety came from the framework, not the model.
   - Source: ROSClaw: An OpenClaw ROS 2 Framework for Agentic Robot Control and Interaction, 2026
   - URL: https://arxiv.org/html/2603.26997v1
   - Evidence: "Llama 4 elicits at least one validator block in 43% of prompts (4.8x GPT-5.2's 9%)... on the humanoid G1 where Llama 4 calls ros2_publish on topics requiring an action server in 41% of failed trials."
   - Cluster: named-tools-robotics

43. On Meta's PARTNR multi-agent embodied benchmark, decentralized two-agent LLM coordination is WORSE than a single agent at runtime: it takes about 31% more simulation steps (3295 decentralized-partial vs 2519 single-agent) and produces a 300% increase in extraneous (wasted) effort, which the authors call a coordination 'burden'. This is direct evidence that adding a second LLM-controlled agent degrades, rather than improves, embodied task execution.
   - Source: PARTNR: A Benchmark for Planning and Reasoning in Embodied Multi-agent Tasks, 2024
   - URL: https://arxiv.org/abs/2411.00081
   - Evidence: "multi-agent...is even slower than ReAct with a single-agent (3295 steps with multi-agent in row(e) versus 2519 with single-agent in row(a)) ... We find a 300% increase in extraneous effort in decentralized multi-agent settings compared to single-agent ... LLMs suffer from a significant coordination 'burden'."
   - Cluster: multirobot-coordination-runtime

44. PARTNR shows a large human-vs-LLM gap on collaborative multi-agent household tasks: humans solve 93% of tasks while state-of-the-art LLMs reach only 30% under non-privileged (realistic perception/skill) conditions, a 63-point gap. Named failure modes are poor coordination, failures in task tracking, and inability to recover from errors. When paired with a human, LLM-guided robots needed 1.5x the steps of a human-human team and 1.1x the steps of a single human.
   - Source: PARTNR: A Benchmark for Planning and Reasoning in Embodied Multi-agent Tasks, 2024
   - URL: https://arxiv.org/abs/2411.00081
   - Evidence: "Humans are able to solve 93% of PARTNR tasks, while SoTA LLMs can only successfully complete 30% under non-privileged conditions ... poor coordination and failures in task tracking and recovery from errors ... LLM-guided robots required 1.5 times more steps than human-human teams and 1.1 times more steps than a single human."
   - Cluster: multirobot-coordination-runtime

45. An independent re-evaluation of PARTNR (Habitat) found that even when high-level two-agent task completion looked decent (reasoning model o3-mini ~89-92%, GPT-4o ~82-88% across centralized and decentralized settings), the systems still exhibited a concrete coordination failure: unbalanced load allocation where one robot worked while the other sat idle, despite both robots being available. This isolates a specific runtime coordination failure mode separate from raw task success.
   - Source: Evaluation of Habitat Robotics using Large Language Models, 2025
   - URL: https://arxiv.org/abs/2507.06157
   - Evidence: "Often the actions assigned were unbalanced meaning one robotic agent had tasks to perform while the other agent was idle."
   - Cluster: multirobot-coordination-runtime

46. DPBench (Dining Philosophers) shows LLM agents handle SEQUENTIAL coordination but fail at SIMULTANEOUS coordination: with N=5 agents acting at once, deadlock ranged from 25.0% (GPT-5.2) to 90.0% (Gemini 2.5 Flash), while sequential action was solved by four of six models. Critically, deadlock was governed by the interaction protocol, not model capability: adding three rounds of pre-commitment communication or a resource-ordering primitive drove Gemini's deadlock from ~90% to 0%.
   - Source: DPBench: Large Language Models Struggle with Simultaneous Coordination, 2026
   - URL: https://arxiv.org/abs/2602.13255
   - Evidence: "deadlock ranges from 25.0% ... for GPT-5.2 to 90.0% ... for Gemini 2.5 Flash ... Whether the same model coordinates or deadlocks is determined by the protocol, not by the model's capability."
   - Cluster: multirobot-coordination-runtime

47. When embodied agents move from oracle ground-truth semantics to a learned perception model on object-search tasks, success drops by about 25.8 percentage points on average (roughly 57% with ground-truth perception versus about 34.7% with one-step learned perception). The authors state this perception gap is often as large as the gap to the optimal policy, meaning perception is as decisive a bottleneck as the planning/control policy itself.
   - Source: Perception Matters: Enhancing Embodied AI with Uncertainty-Aware Semantic Segmentation, 2024
   - URL: https://arxiv.org/abs/2408.02297
   - Evidence: "we find a large test-time gap between ground truth semantics and deployment with a learned model, averaging 25.8 ppt ... an error often as big as the gap to the optimal policy"
   - Cluster: perception-vs-reasoning-confound

48. VLA manipulation policies on standard LIBERO gain only 2.2 to 8.3 percentage points from ground-truth complementary visual information, but on the occlusion variant LIBERO-Occ the same privileged visual access yields 22.1 to 45.5 percentage point gains (a 3-5x amplification). This isolates raw perception (occlusion-induced partial observability) rather than reasoning as the failure cause: the planning capacity is unchanged, only the visible state changes.
   - Source: LIBERO-Occ: Evaluating and Improving Vision-Language-Action Models under Scene-Induced Occlusion via Viewpoint Imagination, 2026
   - URL: https://arxiv.org/html/2606.10862
   - Evidence: "While standard LIBERO observations often contain sufficient information for action prediction, LIBERO-Occ turns manipulation into a partially observable problem"
   - Cluster: perception-vs-reasoning-confound

49. On the SIBench spatial-intelligence benchmark (23 task settings, ~9k samples across three cognitive levels), state-of-the-art VLMs show a pronounced perception-versus-reasoning split: they handle basic perceptual tasks (object existence, occlusion, qualitative spatial relations) competently but collapse on quantitative spatial estimation, multi-view reasoning, and spatial imagination, the last showing near-total absence across all tested models. This supports the claim that the reasoning layer, not just raw sensing, is also weak once perception is held fixed.
   - Source: How Far are VLMs from Visual Spatial Intelligence? A Benchmark-Driven Perspective (SIBench), 2025
   - URL: https://arxiv.org/abs/2509.18905
   - Evidence: "models show competence in basic perceptual tasks but consistently underperform in understanding and planning tasks, particularly in numerical estimation, multi-view reasoning, temporal dynamics, and spatial imagination"
   - Cluster: perception-vs-reasoning-confound

50. MV-RoboBench shows that strong single-view spatial competence does not transfer to multi-view robotic manipulation reasoning. The best model (GPT-5) reaches only 56.4% overall (42.5% on spatial-understanding subtasks, e.g. 29.0% cross-view matching) versus 91.0% human accuracy, a ~35 point gap. Models that score well on the single-view OmniSpatial benchmark remain near random here, isolating viewpoint integration and occlusion resolution as the binding constraint.
   - Source: Seeing Across Views: Benchmarking Spatial Reasoning of Vision-Language Models in Robotic Scenes (MV-RoboBench), 2025
   - URL: https://arxiv.org/abs/2510.19400
   - Evidence: "strong single-view accuracy does not reliably transfer to multi-view embodied reasoning. Many models that perform well on OmniSpatial still remain close to random on MV-RoboBench"
   - Cluster: perception-vs-reasoning-confound

51. Meta's PARTNR benchmark shows LLM embodied agents cannot recover from runtime skill and perception errors: replacing oracle skills with learned skills drops success from 73% to 57%, and removing privileged perception (using ConceptGraphs) drops it further to 30%, versus 93% for humans, because the LLM struggles to correct misclassifications or failed picks.
   - Source: PARTNR: A Benchmark for Planning and Reasoning in Embodied Multi-agent Tasks, 2024
   - URL: https://arxiv.org/html/2411.00081v1
   - Evidence: "While humans are able to solve 93% of PARTNR tasks, SoTA LLMs can only successfully complete 30% under non-privileged conditions ... The LLMs struggle to recover from skill errors like failing to pick up an object or performing incomplete exploration, resulting in a lower success rate."
   - Cluster: runtime-error-recovery-failures

52. The Conditional Multi-Stage Failure Recovery paper demonstrates how poorly embodied agents recover from execution failures by default: the baseline without recovery succeeds on only 24.86% of seen tasks, and even a dedicated four-stage recovery framework raises this to just 36.46% (GPT-4o), meaning a majority of embodied execution failures still go unrecovered.
   - Source: Conditional Multi-Stage Failure Recovery for Embodied Agents, 2025
   - URL: https://arxiv.org/html/2507.06016
   - Evidence: "Embodied agents performing complex tasks are susceptible to execution failures, motivating the need for effective failure recovery mechanisms ... Baseline (no recovery): 24.86% success rate on seen split; CMFR-GPT-4o: 36.46% success rate on seen split."
   - Cluster: runtime-error-recovery-failures

53. Work on agent failure recovery explains the mechanism contrast: a single root-cause error propagates through subsequent decisions because agents lack a framework to detect errors, so they cascade rather than self-correct. The AgentDebug counterfactual approach (substituting a corrected action and re-rolling out) is needed precisely to isolate the earliest irreversible mistake, and even then yields only up to 26% relative task-success improvement.
   - Source: Where LLM Agents Fail and How They Can Learn From Failures (AgentDebug), 2025
   - URL: https://arxiv.org/abs/2509.25370
   - Evidence: "a single root-cause error propagates through subsequent decisions, leading to task failure ... current systems lack a framework that can comprehensively understand agent error in a modular and systemic way, and therefore fail to detect these errors accordingly ... up to 26% relative improvements in task success across ALFWorld, GAIA, and WebShop."
   - Cluster: runtime-error-recovery-failures

## Named agentic tools in robotics

54. ChatDev completes a full software project in roughly 148 seconds using about 22,949 tokens and producing ~4.4 files and ~144 lines of code, illustrating that the pass rate comes with measurable token and runtime overhead.
   - Source: ChatDev: Communicative Agents for Software Development, 2023
   - URL: https://arxiv.org/html/2307.07924v5
   - Evidence: "Duration 148.2148 seconds, Token Usage 22,949.4450 tokens, 4.39 files, 144.3450 lines of code (Table 3)."
   - Cluster: multiagent-devframeworks

55. The ROS2 architecture-recovery pipeline deliberately separates fully deterministic rule-based static analysis (NodeAnalyzer, reproducible) from AI-assisted LLM semantic synthesis, evidence that designers trust LLMs for higher-level semantic reasoning but fence the reliability-critical low-level extraction off to deterministic code.
   - Source: Modeling and Recovering Hierarchical Structural Architectures of ROS 2 Systems from Code and Launch Configurations using LLM-based Agents, 2026
   - URL: https://arxiv.org/html/2602.18644v1
   - Evidence: "The pipeline explicitly separates deterministic static analysis from AI-assisted semantic architecture synthesis; atomic extraction is fully deterministic and reproducible."
   - Cluster: ros-llm-tools

56. ROSA (NASA-JPL Robot Operating System Agent), built on LangChain plus the ReAct paradigm, wraps standard ROS/ROS2 utilities (rosnode, rostopic, rviz) into tool-enabled Python functions for node/topic/service/parameter inspection and log reading, and was demonstrated across three environments (JPL Mars Yard, lab, simulation) with three robots; the paper reports no failure-mode or low-level-control evaluation metrics.
   - Source: Enabling Novel Mission Operations and Interactions with ROSA: The Robot Operating System Agent, 2024
   - URL: https://arxiv.org/abs/2410.06472
   - Evidence: "Tools act as wrappers around standard ROS and ROS2 utilities like rosnode, rostopic, and rviz; the paper does not discuss write-run-read-error-fix loops or limitations in low-level robotic control."
   - Cluster: ros-llm-tools

57. On the RoboTwin imitation-learning subset, RoboCoach reaches 0.59, outscoring the human reference, the named coding agents Codex and Claude Code, and non-agentic prompting; this is the direct named-tool baseline comparison and it only includes Codex and Claude Code (not OpenClaw, ARIS, or Hermes).
   - Source: From Digital to Physical: Digital Agents as Autonomous Coaches for Physical Intelligence, 2026
   - URL: https://arxiv.org/html/2601.21570
   - Evidence: "RoboCoach reaches 0.59 on the RoboTwin imitation-learning subset, above the human reference, Codex, Claude Code, and non-agentic prompting."
   - Cluster: robot-policy-loops

58. AgenticROS (grey literature, Open Robotics Discourse, posted March 31 2026) connects ROS2 to named commercial agentic tools (Claude Code, Claude Desktop/Dispatch, OpenClaw, NemoClaw, Google Gemini) for natural-language robot control via messaging apps, with four deployment modes. It is documented but unvalidated: a user explicitly asked whether it was tested in real life with no documented response, and the project emphasizes simulation (Rviz, Gazebo) without reported reliability or failure rates.
   - Source: AgenticROS: Connects ROS with OpenClaw, Claude (code, desktop, dispatch), and Google Gemini, 2026
   - URL: https://discourse.openrobotics.org/t/agenticros-connects-ros-with-openclaw-claude-code-desktop-dispatch-and-google-gemini/53699
   - Evidence: "One user asked if it operate[s] at real life like, was it tested? with no documented response provided... emphasizes simulation support (Rviz, Gazebo) but doesn't explicitly address production reliability or failure rates."
   - Cluster: named-tools-robotics

59. The ROSBag MCP Server (arXiv, 2025) lets LLMs/VLMs analyze and debug ROS/ROS2 robot data (trajectories, laser scans, transforms, time series) via tool-calling, benchmarking eight models including Claude Sonnet 4. It found a large divide in tool-calling capability with Kimi K2 and Claude Sonnet 4 clearly superior, and that success depends on tool description schema and argument/tool count, evidence that agentic data-debugging quality is model- and tooling-dependent rather than uniformly reliable.
   - Source: ROSBag MCP Server: Analyzing Robot Data with LLMs for Agentic Embodied AI Applications, 2025
   - URL: https://arxiv.org/abs/2511.03497
   - Evidence: "a large divide in tool calling capabilities ... with Kimi K2 and Claude Sonnet 4 demonstrating clearly superior performance; key factors include the tool description schema, argument count, and total tools available."
   - Cluster: named-tools-robotics

60. LLM-as-judge for code is not yet a reliable verifier: a 2026 reliability-aware evaluation framework reports only modest discrimination (ROC-AUC 0.594) and very low inter-judge agreement (mean pairwise Cohen's kappa 0.159, Fleiss' kappa 0.070), cautioning against substituting LLM judges for ground-truth execution in agentic coding harnesses.
   - Source: LLM-as-a-Judge for Human-AI Co-Creation: A Reliability-Aware Evaluation Framework for Coding, 2026
   - URL: https://arxiv.org/abs/2604.27727
   - Evidence: "Best held-out ROC-AUC 0.5937, PR-AUC 0.6904, MCC 0.5000, while inter-judge consistency remains modest (mean pairwise Cohen's kappa = 0.1592, Fleiss' kappa = 0.0696)."
   - Cluster: production-agentic-2026

61. The CaP-X coding-agent-for-manipulation benchmark explicitly introduces a Privileged tier (S1) using ground-truth simulation state (masks and object poses) versus a Non-Privileged tier (S2) using real perception modules on raw RGB-D, expressly to disentangle high-level planning from perception noise and establish a reasoning upper bound. This design confirms that strong embodied coding-agent results commonly assume simulator-provided ground-truth perception, exactly the confound in question (concrete S1-vs-S2 ppt drop not reported in the accessible text).
   - Source: CaP-X: A Framework for Benchmarking and Improving Coding Agents for Robot Manipulation, 2026
   - URL: https://arxiv.org/html/2603.22435v1
   - Evidence: "Privileged (S1), which uses ground-truth simulation state (masks and object poses), and Non-Privileged (S2), which relies on real perception modules processing raw RGB-D inputs ... establishing a reasoning upper bound"
   - Cluster: perception-vs-reasoning-confound

## Benchmark inflation and reliability caveats

62. On SWE-Bench Pro, a harder contamination-resistant benchmark built from GPL/copyleft and private startup repositories (1,865 total instances), the best frontier models score only about 23% on the public set: GPT-5 23.3% and Claude Opus 4.1 22.7%, versus over 70% on SWE-bench Verified. This is a roughly 47-point gap exposing weak generalization.
   - Source: SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?, 2025
   - URL: https://arxiv.org/html/2509.16941v1
   - Evidence: "Public Set (731 problems): GPT-5: 23.3%; Claude Opus 4.1: 22.7%; Claude Sonnet 4: 17.6%; Gemini 2.5 Pro Preview: 13.5%. State-of-the-art agents reportedly achieve over 70% pass rate on SWE-Bench-Verified."
   - Cluster: swe-bench

63. An independent paper (SWE-ABS) confirms the Verified-versus-contamination-resistant gap: on the contamination-resistant SWE-Bench Pro the top system resolves 45.89% versus 78.80% on SWE-Bench Verified, a 33-point drop on the same leaderboard systems.
   - Source: SWE-ABS: Adversarial Benchmark Strengthening Exposes Inflated Success Rates on Test-based Benchmark, 2026
   - URL: https://arxiv.org/pdf/2603.00520
   - Evidence: "the top-system resolve rate on SWE-Bench Pro being 33 points lower than on SWE-Bench Verified (45.89% vs. 78.80%)"
   - Cluster: swe-bench

64. SWE-bench Verified scores are partly inflated by weak test suites: re-evaluating 11,041 patches from the top-30 leaderboard agents with strengthened tests, 19.78% (2,184 patches) of previously accepted solutions are semantically incorrect, dropping the top agent from 78.80% to 62.20% and from 1st to 5th place.
   - Source: SWE-ABS: Adversarial Benchmark Strengthening Exposes Inflated Success Rates on Test-based Benchmark, 2026
   - URL: https://arxiv.org/pdf/2603.00520
   - Evidence: "we reject 2,184 (19.78%) when applying strengthened test suites. This reduces the top agent's success rate by 16.6 percentage points, from 78.80% to 62.20%, causing it to drop from 1st to 5th place."
   - Cluster: swe-bench

65. OpenAI publicly states SWE-bench Verified no longer measures frontier coding capability because progress has slowed and the set is increasingly contaminated, and now recommends SWE-bench Pro for evaluation. This corroborates that headline Verified scores overstate true SWE ability.
   - Source: Why SWE-bench Verified no longer measures frontier coding capabilities (OpenAI), 2025
   - URL: https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
   - Evidence: "State-of-the-art progress on SWE-bench Verified has slowed, and SWE-bench Verified is increasingly contaminated. OpenAI recommends SWE-bench Pro."
   - Cluster: swe-bench

66. SWE-Bench Pro tasks are long-horizon and complex (averaging 107 lines changed across 4 files), and its private/commercial split is designed to resist training-data contamination, providing a more realistic generalization measure where frontier agents drop into the low 20s percent.
   - Source: SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?, 2025
   - URL: https://arxiv.org/abs/2509.16941
   - Evidence: "SWE-Bench Pro curates more challenging instances ... averaging 107 lines across 4 files ... The benchmark contains 1,865 total instances (731 public, 858 held-out, and 276 commercial) across 41 repositories."
   - Cluster: swe-bench

67. A benchmark caveat across these frameworks: their strong scores are concentrated on text/function-level code benchmarks (Defects4J, QuixBugs, HumanEval, MBPP, APPS, CodeContests) that test software-engineering repair and synthesis, not embodied or sensorimotor robotics control, so the results evidence SWE strength rather than runtime embodied capability.
   - Source: CODESIM and UniDebugger benchmark scope (cross-source observation), 2025
   - URL: https://arxiv.org/abs/2502.05664
   - Evidence: "Benchmarks used are software repair/synthesis suites: Defects4J and QuixBugs (program repair) and HumanEval/MBPP/APPS/CodeContests (code generation); none involve physical robot control or spatial sensorimotor tasks."
   - Cluster: multiagent-debug

68. ChatDev's own testing interactions are dominated by environment-level errors, with ModuleNotFound errors occurring in 45.76 percent of testing interactions and NameError and ImportError each at 15.25 percent, showing the tester role frequently surfaces dependency and naming faults rather than deep logic bugs.
   - Source: ChatDev: Communicative Agents for Software Development, 2023
   - URL: https://arxiv.org/html/2307.07924v5
   - Evidence: "'ModuleNotFound' errors occurred in 45.76% of testing interactions, with 'NameError' and 'ImportError' each at 15.25%."
   - Cluster: multiagent-devframeworks

69. When ChatGPT-style agents self-verify their own code, the explanations in their test reports are on average 75 percent inaccurate for incorrectly generated code and failed repairs, and the model exhibits self-contradictory hallucinations, directly undermining the reliability of agent self-testing in frameworks like ChatDev.
   - Source: Fight Fire with Fire: How Much Can We Trust ChatGPT on Source Code-Related Tasks?, 2024
   - URL: https://arxiv.org/html/2405.12641v1
   - Evidence: "The explanations provided in test reports are mostly (an average of 75%) inaccurate for incorrectly generated code and failed repairs."
   - Cluster: multiagent-devframeworks

70. A 2026 study of agent-written tests across six LLMs on SWE-bench Verified finds the tests mainly act as observational feedback (print statements outnumber assertions) and that varying the volume of agent-written tests does not significantly change final task outcomes, so the testing role reshapes process and cost more than correctness.
   - Source: Rethinking the Value of Agent-Generated Tests for LLM-Based Software Engineering Agents, 2026
   - URL: https://arxiv.org/abs/2602.07900
   - Evidence: "Agent-written tests 'mainly serve as observational feedback channels'; 'prompt-induced changes in the volume of agent-written tests do not significantly change final outcomes'; they 'reshape process and cost more than final task outcomes.'"
   - Cluster: multiagent-devframeworks

71. ROS Help Desk was validated using a fault-injection framework spanning three error categories (sensor faults including noise/bias/corruption, communication faults including message loss and delay, and node crashes), and three ROS practitioners rated it a mean 4 out of 5 across five dimensions, establishing the benchmark caveat that the strong detection numbers come from injected, controlled faults rather than open-world failures.
   - Source: ROS Help Desk: GenAI Powered, User-Centric Framework for ROS Error Diagnosis and Debugging, 2025
   - URL: https://arxiv.org/abs/2507.07846
   - Evidence: "Three error categories: sensor faults, communication faults (message loss and delay), and node crashes; expert mean score of 4 out of 5 across all evaluation criteria."
   - Cluster: ros-llm-tools

72. FAEA explicitly relies on privileged ground-truth state access (object positions, gripper state via get_obs) rather than raw RGB images, isolating reasoning from perception; this is a key benchmark caveat, since the high success rates assume the embodied perception problem is solved by the simulator and do not measure raw visual sensorimotor competence.
   - Source: Claude Code As Embodied Agent to Control Robots (author summary of FAEA, arXiv:2601.20334), 2026
   - URL: https://medium.com/@brianytsui/claude-code-as-embodied-agent-to-control-robots-85-96-success-in-sim-with-zero-demonstration-455a9044d353
   - Evidence: "FAEA accesses ground-truth state observations (object positions, gripper state) via get_obs() rather than raw RGB images, which isolates whether frontier agents can discover successful manipulation strategies through iterative reasoning, separate from perception."
   - Cluster: robot-policy-loops

73. OpenAI officially stopped reporting SWE-bench Verified in February 2026 after auditing 138 tasks (the ones o3 could not consistently solve over 64 runs) and finding 59.4% had material test-design or problem-description flaws, meaning a large share of widely cited agentic-coding scores measured benchmark artifacts rather than real software-engineering capability.
   - Source: Why SWE-bench Verified no longer measures frontier coding capabilities (OpenAI), 2026
   - URL: https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
   - Evidence: "59.4% of the 138 problems contained material issues in test design and/or problem description; 35.5% have narrow test cases enforcing specific implementation details that invalidate functionally correct submissions, and 18.8% have wide test cases checking for additional unspecified functionality."
   - Cluster: production-agentic-2026

74. The SWE-Bench Illusion paper shows frontier coding scores are partly driven by memorization, not reasoning: models recall correct buggy file paths up to 76% on SWE-bench Verified but only 53% on equivalent outside-repo tasks (a 23-point drop), and reproduce benchmark code nearly verbatim (Claude 4 Opus exact-match 31.6% of instances).
   - Source: The SWE-Bench Illusion: When State-of-the-Art LLMs Remember Instead of Reason, 2025
   - URL: https://arxiv.org/abs/2506.12286
   - Evidence: "File path identification reaches up to 76% accuracy on SWE-Bench Verified versus up to 53% on outside-repo tasks; Claude 4 Opus shows 31.6% verbatim prefix-completion match, indicating benchmark-specific optimization rather than genuine coding advances."
   - Cluster: production-agentic-2026

75. On the contamination-resistant SWE-Bench Pro (1,865 tasks across 41 actively maintained repos plus private commercial codebases), the best agentic models score far below their inflated Verified numbers: GPT-5 reaches 23.3% and Claude Opus 4.1 22.7% pass@1 on the public set, versus over 70% on SWE-bench Verified, exposing the production gap for long-horizon software engineering.
   - Source: SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?, 2025
   - URL: https://arxiv.org/abs/2509.16941
   - Evidence: "GPT-5 achieves 23.3% and Claude Opus 4.1 22.7% pass@1 on the public set (dropping to 14.9% and 17.8% respectively on private commercial codebases), while state-of-the-art agents report over 70% on SWE-Bench Verified."
   - Cluster: production-agentic-2026

76. SWE-MERA, a dynamic time-stamped benchmark built to defeat contamination, quantifies how broken static SWE-bench-style evaluation is and shows genuinely low fresh-task performance: best model DeepSeek-R1-0528 hit only 27.8% pass@1 on freshly collected tasks, far below the headline numbers on contaminated benchmarks.
   - Source: SWE-MERA: A Dynamic Benchmark for Agenticly Evaluating Large Language Models on Software Engineering Tasks, 2025
   - URL: https://arxiv.org/abs/2507.11059
   - Evidence: "32.67% of successful patches involve direct solution leakage and 31.08% pass due to inadequate test cases in the prior dataset; on fresh tasks DeepSeek-R1-0528 reached 27.8% pass@1 (40.2% pass@6)."
   - Cluster: production-agentic-2026

77. A controlled study on the Lockbox puzzle finds a counterintuitive inversion of the privileged-state assumption: GPT-o1 performed best with raw RGB input (80% success in 11 steps) and worst with perfect ground-truth symbolic state (80% in 15 steps). Injecting 40% perceptual state-flip noise gave a 2.85x success improvement over the noise-free baseline because errors broke repetitive action loops. This complicates the simple privileged-state-helps narrative and shows the reasoning policy, not perception fidelity, drives some failures.
   - Source: Probing Embodied LLMs: When Higher Observation Fidelity Hurts Problem Solving, 2026
   - URL: https://arxiv.org/html/2605.20072
   - Evidence: "agents perform best under raw RGB input and worst under perfect ground-truth observations ... higher input fidelity is associated with lower performance"
   - Cluster: perception-vs-reasoning-confound

78. RoboEval is a robotics-specific code-generation benchmark of 16 service-robot tasks (80 prompts) that checks generated programs by execution traces and temporal-logic correctness; even GPT-4, the strongest model tested, still consistently failed on 1.25% of prompts while weaker models like StarCoder failed on 48.75%, and the work produced a taxonomy of common LLM pitfalls in robot program generation.
   - Source: Deploying and Evaluating LLMs to Program Service Mobile Robots, 2024
   - URL: https://arxiv.org/abs/2311.11183
   - Evidence: "RoboEval ... 16 tasks, each with 5 prompt paraphrases, totaling 80 different prompts ... checks whether the traces satisfy temporal logic properties that encode correctness ... certain prompts (ranging from 48.75% for StarCoder to 1.25% for GPT-4) where LLMs consistently fail to generate correct programs ... a taxonomy that highlights common pitfalls of LLMs at generating robot programs. CodeBotler executes programs on a robot via ROS Actionlib."
   - Cluster: ros-bug-repair-real-code
